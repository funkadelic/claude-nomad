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
import { die, log, warn, NomadFatal } from './utils.ts';
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
 * The narrower set here is deliberate, and the asymmetry with the host-to-repo
 * mirror (which filters on the full `NEVER_SYNC`; see `mirrorOneSharedName` in
 * `links.mirror.ts`) is not an oversight. This is the READ half: widening it
 * changes what an already-synced host RECEIVES on its next pull, so a host that
 * has been getting a directory spelled like a `NEVER_SYNC` entry (`sessions`,
 * `tasks`, ...) under a shared name would silently stop getting it, with no
 * signal at pull time. That is a migration with its own blast radius, not a
 * symmetry tidy-up: what the mirror WRITES into the repo is a separate
 * decision from what a pull is allowed to land on the host.
 *
 * @param src - Source path (`shared/<name>`, repo side).
 * @param dst - Destination path (`~/.claude/<name>`, host side).
 */
export function copySharedLinkPull(src: string, dst: string): void {
  copyExtrasFilteredPreservingBy(src, dst, (name) => isDeniedName(ALWAYS_NEVER_SYNC, name));
}

/**
 * Whether something still occupies `abs`, without following it.
 *
 * `lstat` rather than `existsSync` so a symlink whose target is gone still
 * answers `true`: the question is whether an entry is there, not whether it
 * resolves. A path that cannot be stat-ed for any OTHER reason (no permission
 * on the parent directory, a name over the Windows limit) is reported PRESENT,
 * because the caller uses this to decide what to claim about the path, and
 * guessing absent would hand it a claim it cannot support. Same discipline as
 * `presentAt` in `links.mirror.ts`, applied to the repo-to-host half.
 *
 * @param abs - Absolute path to probe.
 * @returns `true` when something is there, or when it cannot be determined.
 */
function stillOccupied(abs: string): boolean {
  try {
    return lstatSync(abs, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/**
 * What `snapshotBeforeWin32Copy` did, as opposed to what a caller could guess
 * it would do. `snapshotted` means a copy of the previous content was written
 * and can be pointed at; `nothing-to-snapshot` means the snapshot ran but had
 * nothing to copy, which is what a dangling symlink or an entry that vanished
 * between the caller's stat and the backup looks like; `failed` means the
 * snapshot itself errored. Only `failed` stops the copy, and only
 * `snapshotted` earns a mention of the backup dir in a later warning.
 */
type Win32SnapshotOutcome = 'snapshotted' | 'nothing-to-snapshot' | 'failed';

/**
 * Snapshot the `~/.claude/<name>` entry a win32 copy is about to overwrite,
 * reporting both whether the copy may proceed and whether a snapshot exists to
 * name afterwards.
 *
 * The snapshot gets its OWN try/catch, ahead of the copy's, for two reasons.
 * Every way it can fail (no space in the cache directory, no permission on it,
 * a destination over the Windows path limit) happens under
 * `~/.cache/claude-nomad/backup/<ts>/` and says nothing about `linkPath`, so
 * folding it into the copy's catch would blame the file for a failure that
 * happened in the cache directory, the same reason `removeUntrackedDenied`
 * separates the two in `links.mirror.ts`. And a failed snapshot abandons the
 * copy for that name deliberately: the copy is destructive and the snapshot is
 * the only thing that keeps an unpushed local edit recoverable, so proceeding
 * without one would trade a reported, bounded staleness for silent loss of the
 * user's only copy.
 *
 * A snapshot that copied nothing is not a failure and does not stop the copy:
 * `backupBeforeWrite` no-ops when the entry is already gone (its own existence
 * check runs after the caller's stat, so an entry can vanish in between) or
 * when it resolves outside `~/.claude/`. There is simply no backup to point at
 * afterwards, which is why that case is reported rather than folded into the
 * proceed case.
 *
 * @param linkPath - Host-side path about to be overwritten.
 * @param ts - Backup timestamp namespace for `backupBeforeWrite`.
 * @returns The outcome; see `Win32SnapshotOutcome`.
 */
function snapshotBeforeWin32Copy(linkPath: string, ts: string): Win32SnapshotOutcome {
  try {
    return backupBeforeWrite(linkPath, ts) ? 'snapshotted' : 'nothing-to-snapshot';
  } catch (err) {
    warn(
      `could not snapshot ${linkPath} before updating it (${(err as Error).message}), so it was left as it is. The rest of the pull continues`,
    );
    return 'failed';
  }
}

/**
 * Report one win32 apply failure without claiming more than is known.
 *
 * The guard spans the destructive half of the copy, so by the time this runs
 * the entry can be untouched, half-rewritten, or gone: a symlink-era leftover
 * is removed before the copy runs at all, and `copyExtrasFilteredPreservingBy`
 * prunes entries and can remove the destination outright before it writes
 * anything back. An unconditional "it keeps the copy it had" would therefore
 * be exactly wrong in the cases that cost the user something, so only two
 * things are stated. Whether an entry is there now, which `stillOccupied`
 * answers (and answers PRESENT when it cannot tell). And whether a snapshot of
 * the previous content exists to recover from, which the snapshot step reports
 * for itself rather than the caller predicting it, so a snapshot that found
 * nothing left to copy is never advertised as one.
 *
 * @param linkPath - Host-side path the copy was for.
 * @param ts - Backup timestamp, named so the user can find the snapshot.
 * @param err - The caught error; its message is quoted verbatim.
 * @param snapshotted - `true` when a copy of the previous content was written.
 */
function warnWin32ApplyFailed(
  linkPath: string,
  ts: string,
  err: unknown,
  snapshotted: boolean,
): void {
  const state = stillOccupied(linkPath)
    ? 'it may be unchanged, or partly updated'
    : 'nothing is at that path now';
  const recover = snapshotted
    ? ` A copy of what it held before this pull is under backup/${ts}/.`
    : '';
  warn(
    `${linkPath} could not be updated (${(err as Error).message}), so ${state}.${recover} The rest of the pull continues. Check its permissions, or whether another program has it open, then run 'nomad pull' again to update it`,
  );
}

/**
 * Wet-path apply of one shared name on win32: snapshot whatever is already at
 * `linkPath`, clear a symlink-era leftover, then overlay `target` onto it.
 * Extracted from `applySharedLinksWin32`'s loop so both functions stay well
 * inside the cognitive-complexity gate.
 *
 * The whole write half runs inside one `try`/`catch`, so a locked or
 * permission-denied destination costs exactly one name plus one WARN rather
 * than aborting the pull. The catch is deliberately broad (no `err.code`
 * dispatch): the calls it spans bottom out in different syscalls (`lstatSync`,
 * `cpSync`, `readdirSync`, `rmSync`), each of which can raise a different
 * Windows errno for the same underlying lock, so narrowing would miss real
 * cases rather than filter noise. It spans the write half and not just the
 * stat because on win32 a lock on the destination being overwritten is likelier
 * than one on the stat itself.
 *
 * Breadth stops at deliberate failures. A `NomadFatal` is re-thrown: it carries
 * its own message and exit code, and the one this path can raise (the repo-file
 * against host-directory type collision from `copyExtrasFilteredPreservingBy`)
 * names `nomad pull --force-remote`, which is the only command that clears it.
 * `instanceof` is safe for it, unlike `isUserAbort`'s structural match, because
 * the class is thrown from within this process rather than across a library
 * boundary. A backup failure is also a `NomadFatal` now, but `snapshotBeforeWin32Copy`
 * catches it one frame earlier and never lets it reach here; moving a backup
 * call inside this `try` would turn that warn-and-continue into a pull abort.
 *
 * @param target - Source path (`shared/<name>`, repo side).
 * @param linkPath - Destination path (`~/.claude/<name>`, host side).
 * @param ts - Backup timestamp for the pre-write snapshot.
 */
function applyOneSharedLinkWin32(target: string, linkPath: string, ts: string): void {
  let snapshotted = false;
  try {
    const stat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat !== undefined) {
      const snapshot = snapshotBeforeWin32Copy(linkPath, ts);
      if (snapshot === 'failed') return;
      snapshotted = snapshot === 'snapshotted';
      if (stat.isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    }
    copySharedLinkPull(target, linkPath);
  } catch (err) {
    if (err instanceof NomadFatal) throw err;
    warnWin32ApplyFailed(linkPath, ts, err, snapshotted);
  }
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
 * `copySharedLinkPull` handles the overwrite). A snapshot that fails abandons
 * the copy for that name rather than proceeding unbacked; see
 * `snapshotBeforeWin32Copy`. It is NOT routed through `runAutoMovePasses`
 * (that pass is posix-only and would wrongly treat every already-copied file
 * as a conflict to migrate on every subsequent pull).
 *
 * Kept as a separate function (rather than inlined into `applySharedLinks`)
 * so the win32 loop body stays flat under the cognitive-complexity gate.
 *
 * The wet path per name runs through `applyOneSharedLinkWin32`, whose guard
 * turns a locked or permission-denied destination into one skipped name plus
 * one WARN rather than an aborted pull. That guard is NOT the same shape as
 * the host-to-repo mirror's, and the difference is deliberate rather than a
 * drift to be tidied up: `mirrorOneSharedName` (`links.mirror.ts`) wraps only
 * its `lstatSync` and lets its own writes propagate to
 * `reconcileSharedLinksBeforePull`, because on that side the destination is
 * the repo and a skip costs one uncaptured edit with the host untouched. Here
 * the destination is the host entry, which is the thing likely to be locked on
 * win32 and the thing that can be left destroyed by a failed write, so the
 * guard spans the write half and the WARN has to speak to that (see
 * `warnWin32ApplyFailed`).
 *
 * The posix symlink arm of `applySharedLinks`, below, is deliberately left
 * unguarded. Its per-name failure runs through `ensureSymlink`, which calls
 * `die`: a clean `NomadFatal` message plus `EXIT.GENERIC_FAILURE`, no crash
 * report, rather than a raw throw. That failure's trigger is a genuine
 * misconfiguration (a non-symlink squatting the link path), not a transient
 * lock, so whether it should also skip-and-continue rather than stop is a
 * separate question, deliberately not settled here.
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
    applyOneSharedLinkWin32(target, linkPath, ts);
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
