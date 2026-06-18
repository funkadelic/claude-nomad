import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, claudeHome, repoHome, HOST, type PathMap } from './config.ts';
import { classifySettingsDrift } from './commands.capture-settings.core.ts';
import { die, log, warn } from './utils.ts';
import { backupBeforeWrite, ensureSymlink, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, readJson } from './utils.json.ts';

/** Event emitted by `applySharedLinks` when `onPreview` is provided. */
export type LinkPreviewEvent =
  | { kind: 'create'; from: string; to: string }
  | { kind: 'auto-move'; from: string; to: string };

type LinkOpts = { dryRun?: boolean; onPreview?: (e: LinkPreviewEvent) => void };

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
  linkNames: readonly string[],
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
 */
export function applySharedLinks(ts: string, map: PathMap, opts: LinkOpts = {}): void {
  const dryRun = opts.dryRun === true;
  const claude = claudeHome();
  const repo = repoHome();
  // Derive once: allSharedLinks emits a WARN per invalid sharedDirs entry, so
  // calling it per loop would double every such warning in a single run.
  const linkNames = allSharedLinks(map);
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
 * Deep-merge `shared/settings.base.json` with `hosts/<HOST>.json` (when
 * present) and atomically rewrite `~/.claude/settings.json`. Composes
 * `writeJsonAtomic` (temp + fsync + rename + parent fsync) on top of
 * `backupBeforeWrite`, so an interrupted pull leaves either the pre-pull
 * file or the fully-merged file, never a half-written one. Surfaces a
 * stderr WARN when no host override exists AND prior settings has top-level
 * keys not in base; the matching doctor-side FAIL with non-zero exit lives
 * in `cmdDoctor`.
 *
 * `opts.dryRun` (default `false`): when `true`, skip the
 * `backupBeforeWrite` + `writeJsonAtomic` pair and instead log a single
 * `would write settings.json ...` line. The drift-detection WARN above
 * still fires (informational), so users see the same warning a real pull
 * would produce. The unified textual diff of the would-be-written content
 * is produced by `computePreview` in `src/preview.ts`, not here, to keep
 * this function's contract simple (mutation or log-only).
 *
 * Returns `{ label }` where `label` is the override-source tag
 * (`'<HOST>.json'` when a host override exists, else `'no host overrides'`).
 * The WET path no longer logs `wrote settings.json (base + <label>)` inline;
 * `cmdPull` consumes the returned label to render the Settings row of its
 * grouped tree. The dry-run `would write settings.json ...` log and the
 * drift WARN are unchanged (the WET success log is the only thing that moved).
 *
 * @param ts - backup timestamp namespace for `backupBeforeWrite`.
 * @param opts.dryRun - when `true`, log the would-write line and skip mutation.
 * @returns `{ label }` describing the override source for the Settings row.
 */
export function regenerateSettings(ts: string, opts: { dryRun?: boolean } = {}): { label: string } {
  const dryRun = opts.dryRun === true;
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

  // Pull-side drift surface: classify existing settings against the merged
  // result and emit direction-specific guidance. Informational only; pull does
  // NOT abort. The WARN runs in dry-run mode too: the user sees the same drift
  // signal they would see on a real pull. Malformed prior settings.json must
  // not block regeneration; the whole point is to overwrite from base+overrides.
  if (existsSync(settingsPath)) {
    try {
      const existing = readJson<Record<string, unknown>>(settingsPath);
      const drift = classifySettingsDrift(merged, existing);
      if (drift.behind.length > 0) {
        warn(
          `existing settings.json is missing merged keys ${JSON.stringify(drift.behind)}. ` +
            `Run 'nomad pull' to restore them.`,
        );
      }
      if (drift.ahead.length > 0) {
        warn(
          `existing settings.json has local-only keys ${JSON.stringify(drift.ahead)}. ` +
            `Run 'nomad capture-settings' to promote them into the repo before they are overwritten.`,
        );
      }
    } catch {
      warn('existing settings.json is malformed; skipping drift-check and regenerating.');
    }
  }

  const overrideLabel = hasOverrides ? `${HOST}.json` : 'no host overrides';

  if (dryRun) {
    log(`would write settings.json (base + ${overrideLabel})`);
    return { label: overrideLabel };
  }

  backupBeforeWrite(settingsPath, ts);
  writeJsonAtomic(settingsPath, merged);
  return { label: overrideLabel };
}
