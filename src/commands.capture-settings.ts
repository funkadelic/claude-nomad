import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { backupBase, claudeHome, HOST, repoHome } from './config.ts';
import { buildCaptureSubset } from './commands.capture-settings.core.ts';
import { regenerateSettings } from './links.ts';
import { backupRepoWrite, freshBackupTs, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, readJson } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';
import { die, log, warn } from './utils.ts';

/** Confirmation seam: given the destination label and sorted key list, return true to proceed. */
export type CaptureConfirm = (destLabel: string, keys: string[]) => Promise<boolean>;

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
  log(`About to promote ${keys.length} key(s) into ${destLabel}: ${keys.join(', ')}`);
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

/**
 * Promote local-only settings keys into the shared repo.
 *
 * Reads `shared/settings.base.json`, `hosts/<HOST>.json` (when present), and
 * `~/.claude/settings.json`. Computes the ahead-only capture subset via the
 * Plan-01 core. When non-empty, merges the subset into the destination repo
 * file (base by default, host with `--host`), backs up the destination via
 * `backupRepoWrite`, writes atomically, then calls `regenerateSettings` so
 * the local file matches. Idempotent when no ahead-only keys remain.
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
    const subset = buildCaptureSubset(merged, settings, { normalizeNodePath: !useHost });

    if (Object.keys(subset).length === 0) {
      log('nothing to capture: no local-only keys found');
      return;
    }

    const { destPath, existing } = resolveCaptureDestination(repo, useHost);
    const newContent = deepMerge(existing, subset as Partial<typeof existing>);
    const dest = useHost ? `hosts/${HOST}.json` : 'shared/settings.base.json';
    const keys = Object.keys(subset).sort();

    if (dryRun) {
      log(`dry-run: would write ${dest} with keys: ${keys.join(', ')}`);
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

    // Resync the local file from the now-updated repo source. Suppress the
    // pull-side drift WARN: re-advising 'nomad capture-settings' in the run that
    // just captured would be contradictory, and any keys still classified ahead
    // here are the excluded credential keys that capture intentionally refuses.
    regenerateSettings(ts, { suppressDriftWarn: true });
    log(`captured ${keys.length} key(s) into ${dest} (backup: ${ts})`);
  } finally {
    // Release the lock on every exit path. Any NomadFatal propagates to the
    // top-level handler in nomad.ts (which prints it and exits 1); re-wrapping
    // it here would only discard the original error.
    releaseLock(handle);
  }
}
