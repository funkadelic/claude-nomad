import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  repoHome,
  ALWAYS_NEVER_SYNC,
  HOST,
  isDeniedName,
  type PathMap,
} from './config.ts';
import {
  classifySettingsDrift,
  describeSettings,
  partitionByCaptureExclusion,
} from './commands.capture-settings.core.ts';
import { copyExtrasFilteredPreservingBy } from './extras-sync.core.ts';
import { graftGsdHookEntries, keepGsdHookEntries, stripGsdHookEntries } from './hooks-filter.ts';
import { die, log, warn } from './utils.ts';
import { backupBeforeWrite, ensureSymlink, writeJsonAtomic } from './utils.fs.ts';
import { deepMerge, readJson } from './utils.json.ts';

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
  /** Pre-derived name list; falls back to `allSharedLinks(map)` when absent. */
  linkNames?: readonly string[];
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
 * Emit a dry-run copy event via onPreview or fall back to log(). Used by the
 * win32 branch of `applySharedLinks` (`applySharedLinksWin32`), where a real
 * copy replaces symlink creation.
 */
function emitCopy(onPreview: LinkOpts['onPreview'], from: string, to: string): void {
  if (onPreview) {
    onPreview({ kind: 'copy', from, to });
  } else {
    log(`would copy: ${from} -> ${to}`);
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
 * Win32 copy-model helper: overlays `shared/<name>` (repo side) into
 * `~/.claude/<name>` (host side) via `copyExtrasFilteredPreservingBy`, the
 * same predicate-driven preserving-copy primitive `skills-sync.ts` uses for
 * `copySkillsPull`. `SHARED_LINKS` names are not gsd-owned, so no gsd-prefix
 * filter is needed here (contrast `isSkillExcluded`); the predicate only
 * excludes `ALWAYS_NEVER_SYNC` names at every depth, so a crafted
 * `shared/<name>/settings.local.json`-style entry cannot ride into
 * `~/.claude/` from a poisoned repo. `src` may be a single file (`CLAUDE.md`,
 * `my-statusline.cjs`) or a directory (`commands`, `rules`); the underlying
 * `cpSync` handles both.
 *
 * @param src - Source path (`shared/<name>`, repo side).
 * @param dst - Destination path (`~/.claude/<name>`, host side).
 */
export function copySharedLinkPull(src: string, dst: string): void {
  copyExtrasFilteredPreservingBy(src, dst, (name) => isDeniedName(ALWAYS_NEVER_SYNC, name));
}

/**
 * Win32 branch of `applySharedLinks`: materializes each shared link name as a
 * real copy via `copySharedLinkPull` instead of a symlink. Symlink creation on
 * Windows needs Developer Mode or admin, and junctions are directory-only, so
 * file entries like `CLAUDE.md` have no unprivileged symlink equivalent; the
 * accepted trade-off is that Windows edits are captured at the next
 * `nomad push`, the same semantics `skills/` already has.
 *
 * Skips a name entirely when the repo has no `shared/<name>` counterpart
 * (mirrors the posix skip-when-no-counterpart behavior). Any pre-existing
 * entry at `linkPath` is snapshotted via `backupBeforeWrite` before the
 * destructive overlay, so an unpushed local edit is always recoverable from
 * the backup dir: when `linkPath` is a live symlink (a symlink-era leftover
 * from before this branch existed, or a host that previously shared
 * `~/.claude` with a symlink-capable OS), it is backed up and removed before
 * the copy, mirroring `syncSkillsPull`'s migration guard; when `linkPath` is a
 * real, non-symlink entry (the normal post-copy state on win32), it is backed
 * up and then simply overwritten by the copy (no rm needed, `cpSync` inside
 * `copySharedLinkPull` handles the overwrite). It is NOT routed through
 * `runAutoMovePasses` (that pass is posix-only and would wrongly treat every
 * already-copied file as a conflict to migrate on every subsequent pull).
 *
 * Kept as a separate function (rather than inlined into `applySharedLinks`)
 * so the win32 loop body stays flat under the cognitive-complexity gate.
 *
 * @param linkNames - Names to materialize (from `allSharedLinks(map)`).
 * @param claude - `claudeHome()` (host `~/.claude` dir).
 * @param repo - `repoHome()` (local sync repo checkout).
 * @param ts - Backup timestamp for a symlink-era migration.
 * @param dryRun - When `true`, emit a preview event instead of copying.
 * @param onPreview - Structured-event sink; see `LinkOpts.onPreview`.
 */
function applySharedLinksWin32(
  linkNames: readonly string[],
  claude: string,
  repo: string,
  ts: string,
  dryRun: boolean,
  onPreview: LinkOpts['onPreview'],
): void {
  for (const name of linkNames) {
    const target = join(repo, 'shared', name);
    if (!existsSync(target)) continue;
    const linkPath = join(claude, name);
    if (dryRun) {
      emitCopy(onPreview, linkPath, target);
      continue;
    }
    const stat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat !== undefined) {
      backupBeforeWrite(linkPath, ts);
      if (stat.isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    }
    copySharedLinkPull(target, linkPath);
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
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally. This is what lets a caller (`runPullCore`)
 * derive `allSharedLinks(map)` once per command invocation and thread the
 * same list through both the pre-rebase mirror and this apply step, so an
 * invalid `sharedDirs` entry WARNs exactly once per pull instead of once per
 * derivation. Omitting it keeps today's behavior: derive internally, once per
 * call, exactly as documented below.
 */
export function applySharedLinks(ts: string, map: PathMap, opts: LinkOpts = {}): void {
  const dryRun = opts.dryRun === true;
  const claude = claudeHome();
  const repo = repoHome();
  // Derive once: allSharedLinks emits a WARN per invalid sharedDirs entry, so
  // calling it per loop would double every such warning in a single run.
  const linkNames = opts.linkNames ?? allSharedLinks(map);
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
 * Emit the pull-side drift WARNs by classifying the live `existing` settings
 * against the freshly `merged` result: a behind-drift key (present in the
 * synced copy, missing locally) advises `nomad pull`, and a promotable
 * ahead-drift key (local-only, capture-eligible) advises `nomad capture-settings`.
 * Informational only; extracted from `regenerateSettings` so the main function
 * stays under the cognitive-complexity gate.
 *
 * @param merged - The deep-merged base+host result about to be written.
 * @param existing - The parsed live settings.json (well-formed).
 */
function emitDriftWarnings(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
): void {
  const drift = classifySettingsDrift(merged, existing);
  if (drift.behind.length > 0) {
    const { phrase, pronoun } = describeSettings(drift.behind);
    warn(
      `your settings.json is missing ${phrase} that the synced copy has; ` +
        `run 'nomad pull' to restore ${pronoun}.`,
    );
  }
  const { promotable } = partitionByCaptureExclusion(drift.ahead);
  if (promotable.length > 0) {
    const { phrase, pronoun, verb } = describeSettings(promotable);
    warn(
      `your settings.json has ${phrase} that ${verb} not yet synced; ` +
        `run 'nomad capture-settings' to save ${pronoun} to the repo before the next pull overwrites ${pronoun}.`,
    );
  }
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
 * (no gsd hooks in the live file) stays byte-identical. Surfaces a
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
 * `opts.suppressDriftWarn` (default `false`): skip the pull-side drift WARN
 * block. Used by `nomad capture-settings`, which calls this purely to resync the
 * local file right after promoting keys into the repo: re-emitting a "run nomad
 * capture-settings" hint in the same run would be contradictory, and the only
 * keys still classified `ahead` at that point are the deliberately-excluded
 * credential keys (which capture refuses), so the hint would advise an action
 * that cannot succeed.
 *
 * @param ts - backup timestamp namespace for `backupBeforeWrite`.
 * @param opts.dryRun - when `true`, log the would-write line and skip mutation.
 * @param opts.suppressDriftWarn - when `true`, skip the pull-side drift WARN block.
 * @returns `{ label }` describing the override source for the Settings row.
 */
export function regenerateSettings(
  ts: string,
  opts: { dryRun?: boolean; suppressDriftWarn?: boolean } = {},
): { label: string } {
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
  // result and emit direction-specific guidance. Informational only; pull does
  // NOT abort. The WARN runs in dry-run mode too: the user sees the same drift
  // signal they would see on a real pull. Malformed prior settings.json must
  // not block regeneration; the whole point is to overwrite from base+overrides.
  if (!suppressDriftWarn && present) {
    if (malformed) {
      warn('existing settings.json is malformed; skipping drift-check and regenerating.');
    } else {
      emitDriftWarnings(merged, existing);
    }
  }

  const overrideLabel = hasOverrides ? `${HOST}.json` : 'no host overrides';

  if (dryRun) {
    log(`would write settings.json (base + ${overrideLabel})`);
    return { label: overrideLabel };
  }

  // Preserve the gsd-owned hook entries the live file already carries (gsd
  // self-heals them into settings.json each session) by grafting them back onto
  // the stripped merge, so pull stops deleting them. The clean path (no gsd
  // hooks in the live file, or an absent/malformed file) is a byte-identical
  // no-op.
  backupBeforeWrite(settingsPath, ts);
  writeJsonAtomic(
    settingsPath,
    graftGsdHookEntries(stripGsdHookEntries(merged), keepGsdHookEntries(existing)),
  );
  return { label: overrideLabel };
}
