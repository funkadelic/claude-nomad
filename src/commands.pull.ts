import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildExtrasSection,
  buildSessionsSection,
  buildSettingsSection,
} from './commands.push.sections.ts';
import { backupBase, HOST, repoHome, type PathMap } from './config.ts';
import { divergenceCheckExtras, remapExtrasPull } from './extras-sync.ts';
import { applySharedLinks, regenerateSettings } from './links.ts';
import { syncSkillsPull } from './skills-sync.ts';
import { renderTree, section, addItem, type DoctorSection } from './output-tree.ts';
import { computePreview } from './preview.ts';
import { remapPull, scanLocalOnly } from './remap.ts';
import { withSpinner } from './spinner.ts';
import { summaryRow } from './summary.ts';
import {
  classifyWedge,
  unmergedIndexRunbookText,
  wedgeMarkerRunbookText,
} from './commands.pull.wedge.ts';
import { recoverForceRemote, recoverUnmergedIndex } from './commands.pull.recovery.ts';
import { die, fail, gitCaptureRaw, gitOrFatal, log, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';
import { readPathMap } from './utils.json.ts';

/**
 * The pull half's grouped-tree summary-section header. Exported so
 * `commands.sync.ts` can string-match against the exact same literal
 * (`pullHasNoSyncedItems` and `pullPhrase`) instead of duplicating it, which
 * would let the header and its matchers drift apart.
 */
export const PULL_SUMMARY_HEADER = 'Pull summary';

/**
 * Capture one REPO_HOME HEAD SHA. Returns the trimmed SHA, or `undefined` when
 * the repo has no commits yet (unborn HEAD / fresh clone). Swallows the error
 * so the caller can treat `undefined` as "no pre-state" and skip the delete
 * pass entirely (overlay-only is the safe default for a first-ever pull).
 *
 * @param repo - Absolute path to REPO_HOME for the git invocation.
 * @returns Trimmed HEAD SHA, or `undefined` on unborn-HEAD / git error.
 */
function captureHead(repo: string): string | undefined {
  try {
    return gitCaptureRaw(['rev-parse', 'HEAD'], repo).trim();
  } catch {
    return undefined;
  }
}

/**
 * Capture the pre/post-rebase HEAD pair for `.planning` delete-propagation.
 * Calls the provided `rebase` thunk (which runs `git pull --rebase`) between
 * the two captures so both HEADs are taken with the caller's git invocation
 * in between. Returns `{ pre, post }` when both succeed, or `undefined` when
 * either capture yields no SHA (fresh clone / unborn HEAD).
 *
 * Extracting this helper keeps `cmdPull`'s cognitive complexity within the
 * sonarjs/cognitive-complexity limit of 15.
 *
 * @param repo - Absolute path to REPO_HOME.
 * @param rebase - Thunk that runs the actual `git pull --rebase --autostash`.
 * @returns `{ pre, post }` pair, or `undefined` on missing HEAD.
 */
function capturePrePostHeads(
  repo: string,
  rebase: () => void,
): { pre: string; post: string } | undefined {
  const pre = captureHead(repo);
  rebase();
  const post = captureHead(repo);
  if (pre === undefined || post === undefined) return undefined;
  return { pre, post };
}

/**
 * Run the WET (non-dry-run) pull side effects in order and build (but do NOT
 * render) the doctor-style grouped tree sections: `Settings` / `Sessions` /
 * `Extras` / `Pull summary`, matching the `pull on host=... (backup=<ts>)`
 * header printed separately by the caller. `applySharedLinks` stays silent (no
 * Links group by design); `regenerateSettings` returns its override-source
 * label so the Settings row surfaces what was written without logging inline.
 * Sessions/Extras reuse the verb-agnostic builders shared with `cmdPush`, fed
 * the pull-side `pulled` detail arrays. The combined session + extras
 * unmapped count and the extras-skipped count drive the Pull summary row
 * exactly as `emitSummary` did.
 *
 * Returning the sections instead of rendering them lets the caller decide
 * whether to render at all (a composing caller, e.g. a future `nomad sync`,
 * may fold them into a larger compact/full output decision); the standalone
 * `cmdPull` wrapper renders them immediately via `renderTree` so its own
 * output is unchanged.
 *
 * @param ts - backup timestamp namespace shared by every WET side effect.
 * @param prePostHeads - pre/post-rebase HEADs captured by `cmdPull`; threads
 *   into `remapExtrasPull` to drive upstream-deletion propagation for .planning
 *   extras. `undefined` when the pre-rebase capture failed (fresh clone).
 * @returns The ordered `Settings`/`Sessions`/`Extras`/`Pull summary` sections
 *   plus `localOnly`, the read-only count of retained local-only session files.
 */
function buildWetPullSections(
  ts: string,
  map: PathMap,
  prePostHeads?: { pre: string; post: string },
): { sections: DoctorSection[]; localOnly: number } {
  applySharedLinks(ts, map);
  const { label } = regenerateSettings(ts);
  syncSkillsPull(ts);
  const remapResult = withSpinner('Syncing sessions', () => remapPull(ts));
  const extrasResult = remapExtrasPull(ts, { prePostHeads });
  // Read-only count of local-only session files retained by the overlay.
  // Retain-merge never changes the local-only set, so scanning after the copy
  // yields the same count as before it.
  const localOnly = scanLocalOnly();
  // Combine session-unmapped and extras-unmapped into one user-visible count;
  // from the operator's perspective both mean "couldn't sync this for the
  // host". extras-skipped (non-whitelisted dirname) stays separate because it
  // signals config misuse, not a host-config gap.
  const summary = section(PULL_SUMMARY_HEADER);
  addItem(
    summary,
    summaryRow(
      'pull',
      remapResult.unmapped + extrasResult.unmapped,
      0,
      extrasResult.skipped,
      localOnly,
    ),
  );
  return {
    sections: [
      buildSettingsSection(label),
      buildSessionsSection(remapResult.pulled, remapResult.unmapped, localOnly),
      buildExtrasSection(extrasResult.pulled, extrasResult.skipped),
      summary,
    ],
    localOnly,
  };
}

/**
 * Handle the wedge state detected in `REPO_HOME`. Dispatches all three
 * `WedgeState` values returned by `classifyWedge`:
 *
 * - `'rebase'` / `'merge'`: under `--force-remote`, delegates to
 *   `recoverForceRemote` (abort + safety-diff + park + reset --hard).
 *   Without `--force-remote`, dies with an actionable message.
 * - `'unmerged-index'`: under `--force-remote`, delegates to
 *   `recoverUnmergedIndex` (reset --mixed HEAD + autostash surface only;
 *   deliberately not recoverForceRemote, which is scoped to rebase/merge
 *   wedges). Without `--force-remote`, dies with the non-destructive
 *   manual-recovery runbook.
 * - `null`: no-op (clean repo).
 *
 * Called inside the `cmdPull` try block so any `NomadFatal` thrown propagates
 * to the existing catch and the lock is released in `finally`.
 *
 * @param repo        Absolute path to `REPO_HOME`.
 * @param forceRemote Whether `--force-remote` was passed.
 */
function handleWedge(repo: string, forceRemote: boolean): void {
  const wedge = classifyWedge(repo);
  if (wedge === null) return;
  if (wedge === 'unmerged-index') {
    if (forceRemote) {
      recoverUnmergedIndex(repo);
    } else {
      die(unmergedIndexRunbookText('nomad pull'));
    }
    return;
  }
  // wedge is 'rebase' or 'merge': NonNullable<WedgeMode> contract satisfied.
  if (forceRemote) {
    recoverForceRemote(wedge, repo);
    return;
  }
  const state = wedge === 'rebase' ? 'mid-rebase' : 'mid-merge';
  die(wedgeMarkerRunbookText(state));
}

/**
 * Discriminated result returned by `runPullCore`. The `dry` tag carries
 * nothing extra (the dry-run branch renders its own preview tree inline via
 * `computePreview`, matching standalone `cmdPull --dry-run` output). The
 * `wet` tag carries the built (not-yet-rendered) grouped-tree sections plus
 * the summary counts a composing caller needs without re-deriving them:
 * `localOnly` (retained-but-unpushed local-only session files),
 * `divergedKeptLocal` (both-sides-modified extras files the pull kept local
 * on conflict), and `incomingChanges` (whether the rebase actually moved
 * `REPO_HOME`'s HEAD, i.e. `pre !== post`, or `true` when the pre-rebase HEAD
 * could not be captured at all, an unborn HEAD on a fresh clone). A composing
 * caller (`nomad sync`) needs `incomingChanges` rather than inspecting
 * `sections` for synced rows: the pull overlay always re-copies every mapped
 * session/extras dir regardless of whether upstream actually changed, so a
 * `Sessions`/`Extras` row with items does NOT imply a real change, while the
 * rebase HEAD delta does.
 */
export type PullCoreResult =
  | { tag: 'dry' }
  | {
      tag: 'wet';
      sections: DoctorSection[];
      localOnly: number;
      divergedKeptLocal: number;
      incomingChanges: boolean;
    };

/**
 * Lock-free core of `nomad pull`: takes a backup timestamp, runs
 * `git pull --rebase --autostash` in `REPO_HOME`, then applies the
 * side-effecting sync steps in order:
 *   1. `divergenceCheckExtras` (read-only WARN naming local files that
 *      diverge from origin; fires in BOTH wet and dry modes)
 *   2. `applySharedLinks` (symlink shared/* into ~/.claude/)
 *   3. `regenerateSettings` (deep-merge base + host-override into settings.json)
 *   4. `remapPull` (copy repo-side session transcripts into host-encoded dirs)
 *   5. `remapExtrasPull` (copy `shared/extras/<logical>/<dirname>/` back
 *      into each project's localRoot; SKIPPED under dryRun)
 *
 * Assumes the caller already holds the process-wide lock: this function never
 * acquires or releases the lock itself, so it can run standalone (wrapped
 * by `cmdPull`) or as one half of a composing command (e.g. a future
 * `nomad sync`) that holds the lock across both the pull and push halves.
 * It also never catches a fatal error internally; any thrown fault propagates
 * to the caller, whose `try`/`finally` is responsible for releasing the lock.
 *
 * WET output is built (not rendered) as a doctor-style grouped tree
 * (`buildWetPullSections`): `Settings` / `Sessions` / `Extras` / `Pull summary`
 * sections meant to render with tree connector glyphs under a
 * `pull on host=... (backup=<ts>)` header. The Settings row names the
 * regenerated settings.json plus its override-source label; pulled sessions
 * and extras list one row each; the per-project "not in path-map" skips
 * collapse to a single count row. There is no Links group (`applySharedLinks`
 * stays silent by design). The standalone `cmdPull` wrapper renders these
 * sections immediately via `renderTree` so its own output is unchanged from
 * before this refactor.
 *
 * `opts.dryRun` (default `false`): when `true`, `git pull --rebase` still
 * runs (so concurrent invocations cannot race and the user sees the same
 * network round-trip as a real pull). `divergenceCheckExtras` still fires
 * (read-only by design). Then `computePreview` runs in place of the four
 * mutating steps and renders the full preview tree via `renderTree` directly
 * (the dry-run path is not deferred to the caller; only the wet path returns
 * sections for caller-controlled rendering). The per-run backup directory
 * under `~/.cache/claude-nomad/backup/<ts>/` is intentionally NOT created
 * (no backups are written under dryRun and an empty dir would pollute the
 * cache).
 *
 * `opts.forceRemote` (default `false`): when `true` and the repo is wedged
 * mid-rebase or mid-merge, routes to `recoverForceRemote` instead of dying.
 * Recovery aborts the in-progress operation, safety-diffs stranded and dirty
 * tracked changes against `origin/main`, refuses (listing paths) if any
 * touch synced config, otherwise parks stranded commits on
 * `nomad/stranded-<ts>` and resets hard to `origin/main`, then falls through
 * to the normal pull. Cannot combine with `--dry-run`.
 *
 * @param opts.dryRun - Preview mode; see above.
 * @param opts.forceRemote - Wedge recovery mode; see above.
 * @returns A `PullCoreResult` tagged `dry` or `wet` (see `PullCoreResult`).
 */
export function runPullCore(
  opts: { dryRun?: boolean; forceRemote?: boolean } = {},
): PullCoreResult {
  const dryRun = opts.dryRun === true;
  const forceRemote = opts.forceRemote === true;
  // Resolve roots once per function entry (mirrors the convention used by
  // every other command/extras/remap module in this codebase).
  const repo = repoHome();
  const backup = backupBase();
  // Collision-resistant ts: nowTimestamp() is second-resolution, so two
  // pulls in the same wall-clock second would share `ts` and the second's
  // backupBeforeWrite calls (cpSync force:false) would silently no-op.
  const ts = freshBackupTs(backup);
  // Preflight: handle repo stuck mid-rebase or mid-merge. With
  // --force-remote, handleWedge delegates to recoverForceRemote (aborts,
  // safety-diffs, parks stranded commits, resets to origin/main). Without
  // it, handleWedge dies fatally (via die()), which propagates to the
  // caller's catch/finally. No backup dir or git pull runs before this check.
  handleWedge(repo, forceRemote);
  if (!dryRun) {
    // Fail-fast: create backup root BEFORE any mutation. If mkdir fails
    // (out of disk, permission denied), die() throws fatally, which
    // propagates to the caller's catch/finally. Skipped under dryRun: no
    // backups are written, and an empty backup-root dir would pollute the
    // cache.
    const backupRoot = join(backup, ts);
    try {
      mkdirSync(backupRoot, { recursive: true });
    } catch (err) {
      die(`could not create backup dir: ${(err as Error).message}`);
    }
  }
  // WET header becomes the tree header (no `pulling` prefix). The dry-run
  // header phrasing is LEFT byte-identical so the readable diff path does
  // not regress.
  log(
    dryRun
      ? `pulling on host=${HOST} (backup=${ts}; dry-run)`
      : `pull on host=${HOST} (backup=${ts})`,
  );
  // Capture the pre/post-rebase REPO_HOME HEADs and run git pull --rebase
  // --autostash between them. capturePrePostHeads handles the unborn-HEAD
  // case (fresh clone, no commits) by returning undefined; when undefined
  // the delete pass in remapExtrasPull is skipped (overlay only, safe).
  // When pre === post (already up to date) the diff is empty and nothing
  // is deleted (benign no-op).
  const prePostHeads = capturePrePostHeads(repo, () => {
    gitOrFatal(['pull', '--rebase', '--autostash'], 'git pull --rebase', repo);
  });
  // Read path-map.json for sharedDirs/symlink threading. Falls back to a
  // no-sharedDirs map when the file is absent (fresh-clone before init).
  // A parse failure dies fatally, which propagates to the caller's
  // catch/finally.
  const mapPath = join(repo, 'path-map.json');
  const map: PathMap = existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
  // Read-only pre-pull check: fires in BOTH wet and dry modes.
  // Runs AFTER the rebase (so origin content is fetched) and BEFORE any
  // mutation (so local state is intact for byte-level comparison). The
  // function itself silently skips when no `extras` key is declared. Only the
  // dry-run gets prePostHeads for the delete-vs-edit keep-local preview; the
  // wet pull emits that WARN from remapExtrasPull, so passing heads here too
  // would double it. The return value is the both-sides-modified count,
  // carried into the wet result below for a composing caller's summary.
  const divergedKeptLocal = divergenceCheckExtras(ts, dryRun ? prePostHeads : undefined);
  if (dryRun) {
    // computePreview renders the full tree including the Summary row with
    // verb='pull'; no separate emitSummary call (it would duplicate the row).
    // dryRun deliberately omits remapExtrasPull to preserve the
    // zero-mutation contract; users still see the divergence WARN above.
    computePreview(ts, map, 'pull');
    log('dry-run complete; no mutation');
    return { tag: 'dry' };
  }
  const { sections, localOnly } = buildWetPullSections(ts, map, prePostHeads);
  // An unborn/uncapturable pre-rebase HEAD (fresh clone) is treated as
  // "changes present" so a first-ever pull is never collapsed to a no-op;
  // otherwise the signal is the rebase's own HEAD delta, not the sections
  // (the overlay always re-copies mapped dirs, so a synced row alone does
  // not mean anything actually changed upstream).
  const incomingChanges =
    prePostHeads === undefined ? true : prePostHeads.pre !== prePostHeads.post;
  return { tag: 'wet', sections, localOnly, divergedKeptLocal, incomingChanges };
}

/**
 * `nomad pull` command. Acquires the push/pull lock, delegates the entire
 * pull side effect chain to `runPullCore`, renders the wet result's sections
 * (the dry-run path already rendered its own preview tree inside
 * `runPullCore`), and releases the lock. Output and exit codes are unchanged
 * from before the `runPullCore` extraction.
 *
 * The WET-path Pull summary row (including the warn glyph case) renders to STDOUT as
 * part of the grouped tree via `renderTree`, not to stderr via `warn` as in the
 * pre-tree behavior. The dry-run path still routes its summary through
 * `emitSummary` (stderr). This wet-stdout/dry-stderr stream split is
 * intentional (the dry-run output is left byte-identical) and not a regression.
 *
 * Any `NomadFatal` thrown by `runPullCore` is caught here so the `finally`
 * block releases the lock before exit (a raw `process.exit()` would skip
 * `finally` and leak the lock, see `NomadFatal` JSDoc). Non-fatal errors
 * rethrow.
 */
export function cmdPull(opts: { dryRun?: boolean; forceRemote?: boolean } = {}): void {
  // Resolve roots once per command invocation to avoid a time-of-check/
  // time-of-use race: resolving twice could observe a different filesystem
  // state between the check and the use.
  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  // Fire the init-hint FATAL BEFORE acquireLock so an
  // unscaffolded repo never creates a lock file. Keyed off the same signal
  // regenerateSettings uses (shared/settings.base.json), so the two entry
  // points share one phrasing instead of diverging on edits.
  if (!existsSync(join(repo, 'shared', 'settings.base.json'))) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }
  const handle = acquireLock('pull');
  if (handle === null) process.exit(0);
  try {
    const result = runPullCore(opts);
    if (result.tag === 'wet') renderTree(result.sections);
  } catch (err) {
    // Catch fatal errors here so the finally block runs and releases the
    // lock. Throwing through process.exit() would skip finally.
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}
