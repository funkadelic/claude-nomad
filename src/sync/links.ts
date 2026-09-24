import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  repoHome,
  HOST,
  type PathMap,
  type ValidatedSharedNames,
} from '../core/config.ts';
import { classifySettingsDrift, describeSettings } from './settings-classify.ts';
import { graftGsdHookEntries, keepGsdHookEntries, stripGsdHookEntries } from './hooks-filter.ts';
import {
  blockedSettingsKeys,
  credentialOverwriteCount,
  credentialOverwriteMessage,
  removedSettingsKeys,
  settingsRemovedMessage,
  settingsBlockedMessage,
  type WrittenSettings,
} from './settings-guard.ts';
import { preRebaseSettingsMerge } from './settings-upstream.ts';
import { readWrittenSettingsKeys, recordWrittenSettingsKeys } from './settings-written.ts';
import { applySharedLinksWin32 } from './links.win32.ts';
import { die, fail, log, warn } from '../core/utils.ts';
import { backupBeforeWrite, ensureSymlink, writeJsonAtomic } from '../core/utils.fs.ts';
import { deepMerge, readJson } from '../core/utils.json.ts';

// Re-exported so `../commands/adopt.recover.ts` and its test doubles keep
// importing (and mocking) this single name from `links.ts`.
export { copySharedLinkPull } from './links.win32.ts';

/**
 * Event emitted by `applySharedLinks` when `onPreview` is provided. `create`
 * and `auto-move` describe the posix symlink path; `copy` describes the win32
 * copy-model path (see `applySharedLinksWin32`), where a real file/dir is
 * materialized instead of a symlink.
 */
export type LinkPreviewEvent =
  | { kind: 'create'; from: string; to: string }
  | { kind: 'auto-move'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string };

type LinkOpts = {
  dryRun?: boolean;
  onPreview?: (e: LinkPreviewEvent) => void;
  /**
   * Suppress the `sharedDirs` rejection WARNs this call's own
   * `allSharedLinks(map)` derivation would emit, for a caller that already
   * derived the same list once earlier in the same command. Suppresses nothing
   * else: the name list itself is still derived here, from the map this call
   * was handed.
   */
  quietNames?: boolean;
};

/** Emit a dry-run auto-move event via onPreview or fall back to log(). */
function emitAutoMove(
  onPreview: LinkOpts['onPreview'],
  linkPath: string,
  ts: string,
  name: string,
): void {
  if (onPreview) {
    onPreview({ kind: 'auto-move', from: linkPath, to: `backup/${ts}/${name}` });
  } else {
    log(`would auto-move non-symlink: ${linkPath} -> backup/${ts}/${name}`);
  }
}

/** Emit a dry-run create event via onPreview or fall back to log(). */
function emitCreate(onPreview: LinkOpts['onPreview'], from: string, to: string): void {
  if (onPreview) {
    onPreview({ kind: 'create', from, to });
  } else {
    log(`would create symlink: ${from} -> ${to}`);
  }
}

/**
 * Return true when a symlink already exists at `linkPath`, meaning
 * `ensureSymlink` would no-op. `existsSync` follows the symlink, so a dangling
 * symlink (broken target) returns false and is NOT considered satisfied.
 */
function isAlreadySymlink(linkPath: string): boolean {
  return existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink();
}

/**
 * First pass of `applySharedLinks`: for each link name, if a non-symlink
 * occupies the link path and the repo has a counterpart, either preview the
 * auto-move (dry-run) or perform it (wet).
 */
function runAutoMovePasses(
  linkNames: ValidatedSharedNames,
  claude: string,
  repo: string,
  ts: string,
  dryRun: boolean,
  onPreview: LinkOpts['onPreview'],
): void {
  for (const name of linkNames) {
    const linkPath = join(claude, name);
    const target = join(repo, 'shared', name);
    if (!existsSync(linkPath)) continue;
    if (lstatSync(linkPath).isSymbolicLink()) continue;
    if (!existsSync(target)) continue;
    if (dryRun) {
      emitAutoMove(onPreview, linkPath, ts, name);
      continue;
    }
    backupBeforeWrite(linkPath, ts);
    rmSync(linkPath, { recursive: true, force: true });
  }
}

/**
 * Symlink every name in `allSharedLinks(map)` (the static shared-link set
 * plus any validated `sharedDirs` entries from `path-map.json`) from the
 * repo's `shared/` dir into `~/.claude/`. Two-pass: first back up and remove
 * any pre-existing non-symlink at each link path (auto-move using `ts` as the
 * backup timestamp), then create the symlinks. Skips a link entirely when the
 * repo has no `shared/<name>` counterpart, so a host where `shared/commands/`
 * does not exist keeps its local `~/.claude/commands/` instead of having it
 * silently deleted. `sharedDirs` entries route through the identical two-pass
 * logic (refuse-non-symlink / backup / dryRun-log behavior is unchanged).
 *
 * `opts.dryRun` (default `false`): when `true`, no disk mutation occurs.
 *
 * `opts.onPreview`: optional structured-event sink for the dry-run surface.
 * When provided, the would-be auto-move and would-be create events are
 * delivered as `LinkPreviewEvent` objects INSTEAD of the `log(...)` lines.
 * When absent, the `log(...)` fallback is used unchanged so direct-call tests
 * continue to pass.
 *
 * Backwards-compatible: a call with no opts arg or with `dryRun: false` keeps
 * the prior mutating behavior.
 *
 * On `process.platform === 'win32'`, this delegates entirely to
 * `applySharedLinksWin32`, which materializes real copies instead of
 * symlinks (see that function's doc comment). macOS/Linux fall through to the
 * symlink path below, byte-identical to before this branch existed.
 *
 * The name list is ALWAYS derived here, from the `map` this call was handed.
 * It is deliberately not accepted as an argument: on a pull this step runs
 * AFTER the rebase, and the repo state it materializes is the post-rebase one,
 * so a list derived from a pre-rebase map would miss a `sharedDirs` entry (and
 * its `shared/<name>` content) that the pull itself just delivered. A caller
 * that already derived the same list earlier in the same command passes
 * `opts.quietNames` instead, which suppresses the duplicate rejection WARN
 * without letting this step act on a list computed against a different repo
 * state.
 */
export function applySharedLinks(ts: string, map: PathMap, opts: LinkOpts = {}): void {
  const dryRun = opts.dryRun === true;
  const claude = claudeHome();
  const repo = repoHome();
  // Derive once: allSharedLinks emits a WARN per invalid sharedDirs entry, so
  // calling it per loop would double every such warning in a single run.
  const linkNames = allSharedLinks(map, { quiet: opts.quietNames === true });
  if (process.platform === 'win32') {
    applySharedLinksWin32(linkNames, claude, repo, ts, dryRun, opts.onPreview);
    return;
  }
  runAutoMovePasses(linkNames, claude, repo, ts, dryRun, opts.onPreview);
  for (const name of linkNames) {
    const target = join(repo, 'shared', name);
    if (!existsSync(target)) continue;
    const linkPath = join(claude, name);
    // Mirror ensureSymlink's no-op condition so preview cannot diverge from
    // the mutating path: any existing symlink at linkPath is already satisfied.
    if (isAlreadySymlink(linkPath)) continue;
    if (dryRun) {
      emitCreate(opts.onPreview, linkPath, target);
      continue;
    }
    ensureSymlink(linkPath, target);
  }
}

/**
 * Fail-safe read of the live `~/.claude/settings.json`. Returns the parsed
 * object plus `present` (a file exists on disk) and `malformed` (the file
 * exists but is not valid JSON) flags. An absent file yields
 * `{ existing: {}, present: false, malformed: false }`; a malformed file yields
 * `{ existing: {}, present: true, malformed: true }`. Never throws, so one
 * unconditional read can feed both the drift classifier and gsd-hook
 * preservation without duplicating the read or re-deriving the absent/malformed
 * distinction inside `regenerateSettings`.
 *
 * @param settingsPath - Absolute path to `~/.claude/settings.json`.
 * @returns The parsed settings (or `{}`) plus presence and malformed flags.
 */
function readExistingSettings(settingsPath: string): {
  existing: Record<string, unknown>;
  present: boolean;
  malformed: boolean;
} {
  if (!existsSync(settingsPath)) return { existing: {}, present: false, malformed: false };
  try {
    const parsed = readJson<unknown>(settingsPath);
    // Valid-but-non-object JSON (null, an array, a primitive) is treated as
    // malformed: keepGsdHookEntries/stripGsdHookEntries/classifySettingsDrift
    // all dereference it as a plain object, so degrade to nothing-to-preserve
    // rather than crash regeneration.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { existing: {}, present: true, malformed: true };
    }
    return { existing: parsed as Record<string, unknown>, present: true, malformed: false };
  } catch {
    return { existing: {}, present: true, malformed: true };
  }
}

/**
 * Report drift between the live `existing` settings and the freshly `merged`
 * result: a promotable ahead-drift key, or a live-only hook entry under a
 * `hooks` key the merge also carries, is refused (via `fail`) rather than
 * silently overwritten; otherwise a behind-drift key WARNs advising
 * `nomad pull`. The behind WARN is skipped on a refusal, since this pull is
 * not restoring anything. A live-only credential key WARNs by count only.
 * Keys removed upstream are returned, not reported: the caller names them
 * once the write has happened.
 *
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 * @param preMerged - The merge at the pre-pull HEAD (see `blockedSettingsKeys`).
 * @param written - The written-settings record; see `blockedSettingsKeys`.
 * @returns The blocked keys, so the caller can skip the write, and the keys
 *   the write removes (empty when blocked).
 */
function reportSettingsDrift(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  preMerged: Record<string, unknown>,
  written: WrittenSettings | null,
): { blocked: string[]; removed: string[] } {
  const blocked = blockedSettingsKeys(merged, existing, preMerged, written);
  if (blocked.length > 0) {
    fail(settingsBlockedMessage(blocked, 'left unchanged'));
    return { blocked, removed: [] };
  }
  const { behind } = classifySettingsDrift(merged, existing);
  if (behind.length > 0) {
    const { phrase, pronoun } = describeSettings(behind);
    warn(
      `your settings.json is missing ${phrase} that the synced copy has; ` +
        `run 'nomad pull' to restore ${pronoun}.`,
    );
  }
  const credentials = credentialOverwriteCount(merged, existing);
  if (credentials > 0) warn(credentialOverwriteMessage(credentials));
  return { blocked, removed: removedSettingsKeys(merged, existing, preMerged, written) };
}

/**
 * Deep-merge `shared/settings.base.json` with `hosts/<HOST>.json` (when
 * present) and atomically rewrite `~/.claude/settings.json`. Composes
 * `writeJsonAtomic` (temp + fsync + rename + parent fsync) on top of
 * `backupBeforeWrite`, so an interrupted pull leaves either the pre-pull
 * file or the fully-merged file, never a half-written one. Before writing, the
 * gsd-owned hook entries the live file already carries are preserved (grafted
 * back onto the stripped merge via `keepGsdHookEntries` + `graftGsdHookEntries`)
 * so pull stops deleting the hooks gsd self-heals each session; the clean path
 * (no gsd hooks in the live file) stays byte-identical. When the live file
 * has promotable top-level keys that neither this merge nor the pre-pull
 * merge has, or a live-only hook entry under a `hooks` key the merge also
 * carries, prints a stderr refusal naming them and skips the write entirely
 * (no backup, no atomic write).
 *
 * `opts.dryRun` (default `false`): when `true`, skip the
 * `backupBeforeWrite` + `writeJsonAtomic` pair and instead log a single
 * `would write settings.json ...` line. The drift report and refusal above
 * still print, so users see what a real pull would say. The unified textual
 * diff of the would-be-written content is produced by `computePreview` in
 * `src/render/preview.ts`, not here, to keep this function's contract simple
 * (mutation or log-only).
 *
 * @param ts - Backup timestamp namespace for `backupBeforeWrite`.
 * @param opts.dryRun - When `true`, log the would-write line and skip mutation.
 * @param opts.suppressDriftWarn - When `true`, skip the drift report and the
 *   refusal (used by `nomad capture-settings`, so capture never deadlocks).
 * @param opts.prePostHeads - Pre/post-pull HEADs; a key the pre-pull merge had
 *   is treated as removed upstream and deleted instead of refused.
 * @returns `label`, the override-source tag (`'<HOST>.json'` or
 *   `'no host overrides'`) for the Settings row, `blocked`, the keys that
 *   stopped the write (empty when it was written), and `removed`, the keys the
 *   write dropped because the repo no longer carries them.
 */
export function regenerateSettings(
  ts: string,
  opts: {
    dryRun?: boolean;
    suppressDriftWarn?: boolean;
    prePostHeads?: { pre: string; post: string };
  } = {},
): { label: string; blocked: string[]; removed: string[] } {
  const dryRun = opts.dryRun === true;
  const suppressDriftWarn = opts.suppressDriftWarn === true;
  const repo = repoHome();
  const claude = claudeHome();
  const basePath = join(repo, 'shared', 'settings.base.json');
  const hostPath = join(repo, 'hosts', `${HOST}.json`);
  if (!existsSync(basePath)) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }

  const base = readJson<Record<string, unknown>>(basePath);
  const hasOverrides = existsSync(hostPath);
  const overrides = hasOverrides ? readJson<Record<string, unknown>>(hostPath) : {};
  const merged = deepMerge(base, overrides);

  const settingsPath = join(claude, 'settings.json');

  // Read the live settings.json ONCE and unconditionally, fail-safe: the same
  // parsed object feeds both the pull-side drift surface below and the gsd-hook
  // preservation graft at write time. An absent or malformed file degrades to
  // nothing-to-preserve and never blocks regeneration.
  const { existing, present, malformed } = readExistingSettings(settingsPath);

  // Pull-side drift surface: classify existing settings against the merged
  // result and emit direction-specific guidance, refusing a promotable
  // ahead-drift write. Runs in dry-run mode too. Malformed prior
  // settings.json bypasses the gate; the whole point is to overwrite it.
  let blocked: string[] = [];
  let removed: string[] = [];
  if (!suppressDriftWarn && present) {
    if (malformed) {
      warn('existing settings.json is malformed; skipping drift-check and regenerating.');
    } else {
      ({ blocked, removed } = reportSettingsDrift(
        merged,
        existing,
        preRebaseSettingsMerge(repo, opts.prePostHeads),
        readWrittenSettingsKeys(),
      ));
    }
  }

  const overrideLabel = hasOverrides ? `${HOST}.json` : 'no host overrides';

  if (dryRun) {
    if (removed.length > 0) warn(settingsRemovedMessage(removed));
    log(`would write settings.json (base + ${overrideLabel})`);
    return { label: overrideLabel, blocked, removed };
  }

  // A blocked write is skipped entirely: no backup (nothing changes) and no
  // atomic write, leaving the live file exactly as it was.
  if (blocked.length > 0) {
    return { label: overrideLabel, blocked, removed };
  }

  // Preserve the gsd-owned hook entries the live file already carries (gsd
  // self-heals them into settings.json each session) by grafting them back onto
  // the stripped merge, so pull stops deleting them. The clean path (no gsd
  // hooks in the live file, or an absent/malformed file) is a byte-identical
  // no-op.
  backupBeforeWrite(settingsPath, ts);
  const payload = graftGsdHookEntries(stripGsdHookEntries(merged), keepGsdHookEntries(existing));
  writeJsonAtomic(settingsPath, payload);
  recordWrittenSettingsKeys(payload);
  // Named only after the write, so a failed write never announces a removal.
  if (removed.length > 0) warn(settingsRemovedMessage(removed, ts));
  return { label: overrideLabel, blocked, removed };
}
