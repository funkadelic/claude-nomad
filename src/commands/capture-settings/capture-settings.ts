import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { backupBase, claudeHome, HOST, repoHome } from '../../core/config.ts';
import {
  buildCaptureSubset,
  describeSettings,
  keyLabel,
  keyList,
} from '../../sync/settings-classify.ts';
import { pathLabel } from '../../sync/settings-entries.ts';
import { buildHookCaptureSubset, hostReplacesHooks } from '../../sync/hooks-entries.ts';
import { regenerateSettings } from '../../sync/links.ts';
import { blockedHookEntries, removedSettingsKeys } from '../../sync/settings-guard.ts';
import { addNestedEntries, nestedCaptureEntries } from './capture-settings.nested.ts';
import {
  readWrittenEntryIds,
  readWrittenHookIds,
  readWrittenSettingsKeys,
} from '../../sync/settings-written.ts';
import { backupRepoWrite, freshBackupTs, writeJsonAtomic } from '../../core/utils.fs.ts';
import { deepMerge, readJson } from '../../core/utils.json.ts';
import { acquireLock, releaseLock } from '../../core/utils.lockfile.ts';
import { die, log, warn } from '../../core/utils.ts';

/** Confirmation seam: given the destination label and sorted key list, return true to proceed. */
type CaptureConfirm = (destLabel: string, keys: string[]) => Promise<boolean>;

/** Options for the `nomad capture-settings` subcommand. */
export type CaptureSettingsOpts = {
  /** When true, write to `hosts/<HOST>.json` instead of `shared/settings.base.json`. */
  host: boolean;
  /** When true, print what would change without writing anything. */
  dryRun: boolean;
  /** When true, skip the interactive confirmation prompt (required for non-interactive use). */
  yes?: boolean;
  /**
   * Confirmation seam. Defaults to a TTY-guarded readline y/N prompt; injected
   * by tests for deterministic accept/decline behaviour. Ignored when `yes` is
   * true or `dryRun` is true (no write happens).
   */
  confirm?: CaptureConfirm;
};

/* c8 ignore start */
/**
 * Default confirmation: on an interactive TTY, print the destination and keys
 * then read a y/N answer; in a non-interactive shell, refuse and instruct the
 * user to pass `--yes`. c8-ignored because it drives real stdin/readline; the
 * accept/decline branches are covered through the injected `confirm` seam.
 *
 * @param destLabel - Repo-relative destination being written.
 * @param keys - Sorted list of keys that would be promoted.
 * @returns True when the user confirms the write.
 */
async function confirmCapture(destLabel: string, keys: string[]): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    warn(
      `refusing to write ${destLabel} without confirmation in a non-interactive shell; ` +
        're-run with --yes (or --dry-run to preview)',
    );
    return false;
  }
  log(`About to promote ${keys.length} setting(s) into ${destLabel}: ${keyList(keys)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
/* c8 ignore stop */

/**
 * Resolve the repo destination path and the current content of that file.
 *
 * @param repo - Absolute path to the sync repo root.
 * @param useHost - When true, target `hosts/<HOST>.json`; else target `shared/settings.base.json`.
 * @returns `{ destPath, existing }` where `existing` is the current file content (or `{}`).
 */
function resolveCaptureDestination(
  repo: string,
  useHost: boolean,
): { destPath: string; existing: Record<string, unknown> } {
  const destPath = useHost
    ? join(repo, 'hosts', `${HOST}.json`)
    : join(repo, 'shared', 'settings.base.json');
  const existing = existsSync(destPath) ? readJson<Record<string, unknown>>(destPath) : {};
  return { destPath, existing };
}

/** Sources `collectCapture` composes into one capture subset. */
type CaptureSources = {
  base: Record<string, unknown>;
  overrides: Record<string, unknown>;
  merged: Record<string, unknown>;
  settings: Record<string, unknown>;
};

/**
 * Compose the top-level `ahead`-key capture with the hook-entry capture and new
 * entries inside an object key the repo already has, warning about
 * skipped/shadowed hook events before the caller decides whether there is
 * anything to write.
 */
function collectCapture(
  sources: CaptureSources,
  useHost: boolean,
): {
  subset: Record<string, unknown>;
  keys: string[];
  skipped: string[];
  clashed: boolean;
  removed: string[];
} {
  const topSubset = buildCaptureSubset(sources.merged, sources.settings, {
    normalizeNodePath: !useHost,
  });
  // Leave out entries a pull deletes as removed upstream, so capture never undoes that removal.
  const written = readWrittenSettingsKeys();
  const hookIds = readWrittenHookIds();
  const entryIds = readWrittenEntryIds();
  const entries = blockedHookEntries(sources.merged, sources.settings, {}, written, hookIds);
  const { entries: nested, clashed } = nestedCaptureEntries(sources, useHost, written, entryIds);
  const { hooks, shadowed, skipped } = buildHookCaptureSubset({ ...sources, entries }, useHost);

  for (const event of skipped.map(keyLabel)) {
    warn(
      `not saving ${event} hooks to shared/settings.base.json: hosts/${HOST}.json overrides ` +
        `them on this host, so the shared ones never reach it; run 'nomad capture-settings ` +
        `--host' to save them there`,
    );
  }
  for (const event of shadowed.map(keyLabel)) {
    warn(
      `hosts/${HOST}.json will carry this host's full ${event} hook list, so later edits to ` +
        `${event} hooks in shared/settings.base.json will not reach this host`,
    );
  }

  const hookEventKeys = Object.keys(hooks);
  if (useHost && hookEventKeys.length > 0 && hostReplacesHooks(sources.overrides)) {
    warn(
      `hosts/${HOST}.json sets hooks to a non-object value, which drops every shared hook on ` +
        `this host; saving replaces it with these hook events, so the shared hooks for every ` +
        `other event reach this host again`,
    );
  }
  const subset: Record<string, unknown> = { ...topSubset };
  if (hookEventKeys.length > 0) subset.hooks = hooks;
  addNestedEntries(subset, nested, sources.merged, useHost);

  const keys = [
    ...Object.keys(topSubset).map(keyLabel),
    ...hookEventKeys.map((e) => pathLabel(['hooks', e])),
    ...nested.map((e) => e.label),
  ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  // Entries the repo dropped that this capture does not save back; the resync deletes them.
  const captured = new Set(keys);
  const removed = removedSettingsKeys(
    sources.merged,
    sources.settings,
    {},
    written,
    hookIds,
    entryIds,
  );
  return { subset, keys, skipped, clashed, removed: removed.filter((k) => !captured.has(k)) };
}

/**
 * Regenerate the live settings.json from the updated repo, unless something was
 * left unsaved: a regenerate would delete it before it is saved.
 */
function resyncLive(ts: string, skipped: string[], clashed: boolean, removed: string[]): void {
  if (skipped.length > 0) {
    // A regenerate would delete the skipped hooks from the live file before they are saved.
    warn(
      "settings.json left unchanged so the skipped hooks stay; run 'nomad capture-settings " +
        "--host' to save them, then pull",
    );
  } else if (clashed) {
    // A regenerate would delete the entries the destination clash kept out.
    warn('settings.json left unchanged so the unsaved entries stay; pull once they are saved');
  } else {
    // Resync the local file from the now-updated repo source. Suppress the
    // pull-side drift WARN: re-advising 'nomad capture-settings' in the run
    // that just captured would be contradictory.
    regenerateSettings(ts, { suppressDriftWarn: true });
    if (removed.length > 0) {
      const { phrase, pronoun } = describeSettings(removed);
      warn(
        `this capture also removed ${phrase} from settings.json because the repo no longer ` +
          `carries ${pronoun}; the previous file is at ~/.cache/claude-nomad/backup/${ts}/settings.json.`,
      );
    }
  }
}

/**
 * Promote local-only settings keys into the shared repo.
 *
 * Reads `shared/settings.base.json`, `hosts/<HOST>.json` (when present), and
 * `~/.claude/settings.json`. Computes the ahead-only key capture plus any
 * live-only hook entries under a `hooks` key the repo already carries and any
 * new entries inside an object key the repo already has. When
 * non-empty, merges the subset into the destination repo file (base by
 * default, host with `--host`), backs up the destination via
 * `backupRepoWrite`, writes atomically, then calls `regenerateSettings` so
 * the local file matches. Idempotent when nothing local-only remains.
 *
 * Before any wet write the user must confirm (destination + key list), unless
 * `--yes` is passed or the run is `--dry-run`. In a non-interactive shell the
 * default confirmation refuses, so an unattended run does not silently fan a
 * key out to every host; pass `--yes` to opt in.
 *
 * @param opts Command options (host destination flag, dry-run flag, yes flag, confirm seam).
 */
export async function cmdCaptureSettings(opts: CaptureSettingsOpts): Promise<void> {
  const { host: useHost, dryRun } = opts;

  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);

  const handle = acquireLock('capture-settings');
  if (handle === null) process.exit(0);
  try {
    const claude = claudeHome();
    const basePath = join(repo, 'shared', 'settings.base.json');
    if (!existsSync(basePath)) {
      die("repo not initialized; run 'nomad init' to scaffold");
    }

    const settingsPath = join(claude, 'settings.json');
    if (!existsSync(settingsPath)) {
      log('no ~/.claude/settings.json found; nothing to capture');
      return;
    }

    const base = readJson<Record<string, unknown>>(basePath);
    const hostPath = join(repo, 'hosts', `${HOST}.json`);
    const overrides = existsSync(hostPath) ? readJson<Record<string, unknown>>(hostPath) : {};
    const merged = deepMerge(base, overrides);

    const settings = readJson<Record<string, unknown>>(settingsPath);
    const { subset, keys, skipped, clashed, removed } = collectCapture(
      { base, overrides, merged, settings },
      useHost,
    );

    if (keys.length === 0) {
      if (skipped.length === 0 && !clashed) log('nothing to capture: no local-only keys found');
      return;
    }

    const { destPath, existing } = resolveCaptureDestination(repo, useHost);
    const newContent = deepMerge(existing, subset as Partial<typeof existing>);
    const dest = useHost ? `hosts/${HOST}.json` : 'shared/settings.base.json';

    if (dryRun) {
      log(`dry-run: would write ${dest} with keys: ${keyList(keys)}`);
      return;
    }

    if (opts.yes !== true) {
      const confirm = opts.confirm ?? confirmCapture;
      const proceed = await confirm(dest, keys);
      if (!proceed) {
        log('capture aborted; nothing written');
        return;
      }
    }

    const ts = freshBackupTs(backupBase());
    backupRepoWrite(destPath, ts, repo);
    writeJsonAtomic(destPath, newContent);

    resyncLive(ts, skipped, clashed, removed);
    log(`captured ${keys.length} setting(s) into ${dest} (backup: ${ts})`);
  } finally {
    // Release the lock on every exit path. Any NomadFatal propagates to the
    // top-level handler in nomad.ts (which prints it and exits 1); re-wrapping
    // it here would only discard the original error.
    releaseLock(handle);
  }
}
