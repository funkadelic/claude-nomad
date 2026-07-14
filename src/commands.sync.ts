/**
 * `nomad sync`: one command that runs the pull half (retain-merge overlay,
 * safe to run first) and then the push half (reconciles local-only sessions
 * and kept-local diverged extras to the remote) under a single held lock, so
 * callers never have to reason about push/pull ordering.
 *
 * `cmdSync` is composition only: it delegates every side effect to the
 * lock-free `runPullCore` / `runPushCore` bodies (see `commands.pull.ts` /
 * `commands.push.ts`, both run in compose mode so neither renders) and owns
 * nothing but lock scope, control flow, and the single merged-tree render
 * ending in the two-phase Sync summary. The push half's full safety pipeline
 * (secret scan, interactive recovery on a leak) runs unchanged inside
 * `runPushCore`; this module never re-implements or bypasses it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PULL_SUMMARY_HEADER, runPullCore, type PullCoreResult } from './commands.pull.ts';
import { runPushCore, type PushCoreResult } from './commands.push.ts';
import { backupBase, HOST, repoHome, type PathMap } from './config.ts';
import { computePreview } from './preview.ts';
import { addItem, renderTree, section, type DoctorSection } from './output-tree.ts';
import { die, fail, log, ok, NomadFatal } from './utils.ts';
import { freshBackupTs } from './utils.fs.ts';
import { readPathMap } from './utils.json.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';

/** The wet pull result shape carrying the sections a composing caller renders. */
type WetPull = Extract<PullCoreResult, { tag: 'wet' }>;

/**
 * Outcome of the push half, discriminated so a caller never needs to check a
 * result for `undefined`: a successful run carries the `PushCoreResult` tag,
 * a failed run carries the fatal message. `process.exitCode` is already set
 * to `1` on the `ok: false` arm.
 */
type PushOutcome = { ok: true; result: PushCoreResult } | { ok: false; message: string };

/**
 * True when neither half of this run changed anything: the pull half's rebase
 * moved nothing (`!pull.incomingChanges`) and retained nothing new (no
 * local-only sessions, no diverged files kept local), and the push half found
 * nothing to push. Callers use this to collapse the run to a single compact
 * line instead of two full grouped trees.
 *
 * Gating on `incomingChanges` rather than the pull sections' row contents is
 * deliberate: the pull overlay always re-copies every mapped session/extras
 * dir, so a `Sessions`/`Extras` row with items does NOT by itself mean
 * anything changed upstream; the rebase HEAD delta does.
 *
 * A `nothing`-tagged push half with `aheadOfOrigin: true` never collapses:
 * the sync repo carries committed-but-unpushed work (e.g. a prior push
 * committed and then the network push failed), so asserting "already in
 * sync" would mask exactly the state a sync run exists to surface.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 * @returns `true` when the run is a true no-op.
 */
function isNoopSync(pull: WetPull, pushOutcome: PushOutcome): boolean {
  if (!pushOutcome.ok) return false;
  if (pull.localOnly !== 0 || pull.divergedKeptLocal !== 0) return false;
  if (pushOutcome.result.tag !== 'nothing') return false;
  if (pushOutcome.result.aheadOfOrigin === true) return false;
  return !pull.incomingChanges;
}

/**
 * Read the pull half's own Pull summary row text so the two-phase status line
 * below reuses its exact phrasing instead of recomputing it. Falls back to
 * `'applied'` in the defensive case where the pull sections carry no Pull
 * summary row (never happens in practice; the wet pull path always appends one).
 *
 * @param pull - The wet pull result.
 * @returns The pull half's Pull summary row text, or `'applied'` as a fallback.
 */
function pullPhrase(pull: WetPull): string {
  const summary = pull.sections.find((s) => s.header === PULL_SUMMARY_HEADER);
  return summary?.items[0] ?? 'applied';
}

/**
 * Build the reconciled-work notes for a successful run: one line naming how
 * many diverged extras files the pull half kept local (now pushed) and one
 * line naming how many local-only sessions the pull half retained (now
 * pushed). Both are omitted when their count is zero.
 *
 * @param pull - The wet pull result.
 * @returns Zero, one, or two note lines.
 */
function reconciledNotes(pull: WetPull): string[] {
  const notes: string[] = [];
  if (pull.divergedKeptLocal > 0) {
    notes.push(`${pull.divergedKeptLocal} diverged files kept local and pushed`);
  }
  if (pull.localOnly > 0) {
    notes.push(`${pull.localOnly} local-only sessions pushed`);
  }
  return notes;
}

/**
 * Build the two-phase status Sync summary section rendered after the pull
 * tree. On a failed push half this collapses to the single status line naming
 * which half failed; on a successful run it lists a `pull:` row, a `push:`
 * row, a committed-but-unpushed note when the push half reported
 * `aheadOfOrigin`, and any reconciled-work notes.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 * @returns The `Sync summary` section for the two-phase status.
 */
function buildSyncSummarySection(pull: WetPull, pushOutcome: PushOutcome): DoctorSection {
  const s = section('Sync summary');
  if (!pushOutcome.ok) {
    addItem(s, `pull: applied, push: failed (${pushOutcome.message})`);
    return s;
  }
  addItem(s, `pull: ${pullPhrase(pull)}`);
  addItem(s, `push: ${pushOutcome.result.tag === 'pushed' ? 'pushed' : 'nothing to push'}`);
  if (pushOutcome.result.tag === 'nothing' && pushOutcome.result.aheadOfOrigin === true) {
    addItem(s, 'sync repo has unpushed commits');
  }
  for (const note of reconciledNotes(pull)) addItem(s, note);
  return s;
}

/**
 * Canonical merged-tree section order: the pull-owned Settings leads, then
 * the push-only Global config, the merged Sessions/Extras, and the push-only
 * Leak scan. The caller appends the Sync summary after these.
 */
const SYNC_SECTION_ORDER = ['Settings', 'Global config', 'Sessions', 'Extras', 'Leak scan'];

/**
 * Merge the pull half's and push half's built sections into one tree: the
 * `Pull summary` (`PULL_SUMMARY_HEADER`) and `Push summary` sections are
 * dropped (the single Sync summary replaces both; they are the only wet
 * headers outside `SYNC_SECTION_ORDER`, so the header-map lookup below drops
 * exactly them), the remaining sections are grouped by header in
 * `SYNC_SECTION_ORDER`, and within each header the items from both halves
 * are concatenated de-duplicated by exact string value in first-seen order
 * (so the byte-identical `not in path-map` skip row both halves emit
 * collapses to one).
 *
 * @param pullSections - The wet pull result's built sections.
 * @param pushSections - The push half's built sections (compose mode).
 * @returns The ordered non-empty merged sections.
 */
function mergeSyncSections(
  pullSections: DoctorSection[],
  pushSections: DoctorSection[],
): DoctorSection[] {
  const byHeader = new Map<string, DoctorSection>(
    SYNC_SECTION_ORDER.map((header) => [header, section(header)]),
  );
  for (const s of [...pullSections, ...pushSections]) {
    const target = byHeader.get(s.header);
    // Headers outside SYNC_SECTION_ORDER are the two dropped summaries.
    if (target === undefined) continue;
    for (const item of s.items) {
      if (!target.items.includes(item)) addItem(target, item);
    }
  }
  return [...byHeader.values()].filter((s) => s.items.length > 0);
}

/**
 * Read the push half's built sections out of a successful compose-mode
 * outcome. A failed push half or a tag without sections (the `dry` arm, or
 * the resolved-leak path that already rendered inline) yields an empty array.
 *
 * @param pushOutcome - The push half's outcome.
 * @returns The push half's built sections, or `[]`.
 */
function pushSectionsOf(pushOutcome: PushOutcome): DoctorSection[] {
  if (!pushOutcome.ok) return [];
  const result = pushOutcome.result;
  if (result.tag === 'dry') return [];
  return result.sections ?? [];
}

/**
 * Render the wet-sync result: a compact `already in sync` line when nothing
 * changed on either half, otherwise a single `sync on host=...` header
 * followed by ONE merged grouped tree (both halves' sections merged in
 * pull-then-push canonical order, each duplicated fact stated once) ending
 * in the two-phase status Sync summary. Both halves ran in compose mode, so
 * nothing has rendered before this function; it owns the entire output.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 */
function renderWetSync(pull: WetPull, pushOutcome: PushOutcome): void {
  if (isNoopSync(pull, pushOutcome)) {
    ok('already in sync');
    return;
  }
  log(`sync on host=${HOST}`);
  const merged = mergeSyncSections(pull.sections, pushSectionsOf(pushOutcome));
  renderTree([...merged, buildSyncSummarySection(pull, pushOutcome)]);
}

/**
 * Run the push half and convert a fatal push failure into a `PushOutcome`
 * instead of letting it propagate: a pull-half failure must stop the run
 * before this is ever called, but a push-half failure after a successful
 * pull must NOT unwind past this point (the pull's effects stay applied, no
 * rollback). Sets `process.exitCode = 1` on failure; a non-fatal error still
 * propagates unchanged.
 *
 * @returns The push half's outcome.
 */
async function runSyncPushHalf(): Promise<PushOutcome> {
  try {
    const result = await runPushCore({ compose: true });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof NomadFatal) {
      process.exitCode = 1;
      return { ok: false, message: err.message };
    }
    throw err;
  }
}

/**
 * Run the wet (real) sync: the pull half first, then the push half, both in
 * compose mode so neither renders anything itself and `renderWetSync` owns
 * the single merged tree. A pull-half fatal error is NOT caught here, so it
 * propagates to `cmdSync`'s own catch and the push half never runs. The pull
 * half always returns the `wet` tag when run without a preview flag, so the
 * cast below carries no risk.
 */
async function runSyncWet(): Promise<void> {
  const pull = runPullCore({ compose: true }) as WetPull;
  const pushOutcome = await runSyncPushHalf();
  renderWetSync(pull, pushOutcome);
}

/**
 * Run the dry-run preview: the pull-side preview first (matching `nomad pull
 * --dry-run`'s own rendering), then a one-line caveat that the push preview
 * below is computed against pre-pull state (a real sync pushes after the
 * pull half applies), then the push half's own preview. Neither half mutates
 * anything.
 *
 * @param repo - Resolved repository root.
 * @param backup - Resolved backup cache root.
 */
async function runSyncDryRun(repo: string, backup: string): Promise<void> {
  const ts = freshBackupTs(backup);
  const mapPath = join(repo, 'path-map.json');
  const map: PathMap = existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
  computePreview(ts, map, 'pull');
  log('push preview below is computed against pre-pull state (a real sync pushes after pull)');
  await runPushCore({ dryRun: true });
}

/**
 * `nomad sync` command. Acquires a single lock spanning both halves, runs the
 * pull half then the push half (or, under `dryRun`, both previews), and
 * releases the lock. A fatal error from either half sets
 * `process.exitCode = 1`; the `finally` block guarantees the lock is
 * released even when a half throws.
 *
 * @param opts.dryRun - Preview mode: stacks both previews, mutates nothing.
 */
export async function cmdSync(opts: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = opts.dryRun === true;
  // Resolve roots once per command invocation (TOCTOU mitigation, mirrors
  // cmdPull/cmdPush).
  const repo = repoHome();
  const backup = backupBase();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  if (!existsSync(join(repo, 'shared', 'settings.base.json'))) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }
  const handle = acquireLock('sync');
  if (handle === null) process.exit(0);
  try {
    if (dryRun) {
      await runSyncDryRun(repo, backup);
    } else {
      await runSyncWet();
    }
  } catch (err) {
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
