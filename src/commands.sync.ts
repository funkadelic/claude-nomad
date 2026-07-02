/**
 * `nomad sync`: one command that runs the pull half (retain-merge overlay,
 * safe to run first) and then the push half (reconciles local-only sessions
 * and kept-local diverged extras to the remote) under a single held lock, so
 * callers never have to reason about push/pull ordering.
 *
 * `cmdSync` is composition only: it delegates every side effect to the
 * lock-free `runPullCore` / `runPushCore` bodies (see `commands.pull.ts` /
 * `commands.push.ts`) and owns nothing but lock scope, control flow, and the
 * two-phase status rendering. The push half's full safety pipeline (secret
 * scan, interactive recovery on a leak) runs unchanged inside `runPushCore`;
 * this module never re-implements or bypasses it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { runPullCore, type PullCoreResult } from './commands.pull.ts';
import { runPushCore, type PushCoreResult } from './commands.push.ts';
import { backupBase, repoHome, type PathMap } from './config.ts';
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
 * True when the sections a wet pull built carry no synced-item rows: every
 * section is either `Settings` (always one row, the regenerated
 * settings.json), `Summary` (always one row), or has zero items. Used to
 * decide whether the pull half actually moved anything.
 *
 * @param sections - The grouped-tree sections returned by a wet pull.
 * @returns `true` when no Sessions/Extras rows were produced.
 */
function pullHasNoSyncedItems(sections: DoctorSection[]): boolean {
  return sections.every(
    (s) => s.header === 'Settings' || s.header === 'Summary' || s.items.length === 0,
  );
}

/**
 * True when neither half of this run changed anything: the pull half synced
 * no items and retained nothing new (no local-only sessions, no diverged
 * files kept local), and the push half found nothing to push. Callers use
 * this to collapse the run to a single compact line instead of two full
 * grouped trees.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 * @returns `true` when the run is a true no-op.
 */
function isNoopSync(pull: WetPull, pushOutcome: PushOutcome): boolean {
  if (!pushOutcome.ok) return false;
  if (pull.localOnly !== 0 || pull.divergedKeptLocal !== 0) return false;
  if (pushOutcome.result.tag !== 'nothing') return false;
  return pullHasNoSyncedItems(pull.sections);
}

/**
 * Read the pull half's own Summary row text so the two-phase status line
 * below reuses its exact phrasing instead of recomputing it. Falls back to
 * `'applied'` in the defensive case where the pull sections carry no Summary
 * row (never happens in practice; the wet pull path always appends one).
 *
 * @param pull - The wet pull result.
 * @returns The pull half's Summary row text, or `'applied'` as a fallback.
 */
function pullPhrase(pull: WetPull): string {
  const summary = pull.sections.find((s) => s.header === 'Summary');
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
 * Build the two-phase status Summary section rendered after the pull tree. On
 * a failed push half this collapses to the single status line naming which
 * half failed; on a successful run it lists a `pull:` row, a `push:` row, and
 * any reconciled-work notes.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 * @returns The `Summary` section for the two-phase status.
 */
function buildSyncSummarySection(pull: WetPull, pushOutcome: PushOutcome): DoctorSection {
  const s = section('Summary');
  if (!pushOutcome.ok) {
    addItem(s, `pull: applied, push: failed (${pushOutcome.message})`);
    return s;
  }
  addItem(s, `pull: ${pullPhrase(pull)}`);
  addItem(s, `push: ${pushOutcome.result.tag === 'pushed' ? 'pushed' : 'nothing to push'}`);
  for (const note of reconciledNotes(pull)) addItem(s, note);
  return s;
}

/**
 * Render the wet-sync result: a compact `already in sync` line when nothing
 * changed on either half, otherwise the pull half's own grouped tree followed
 * by the two-phase status Summary. The push half's own grouped tree (or its
 * `nothing to commit` no-scan tree) has already rendered by the time this
 * runs; this function only ever adds the pull tree and the final status line
 * on top.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 */
function renderWetSync(pull: WetPull, pushOutcome: PushOutcome): void {
  if (isNoopSync(pull, pushOutcome)) {
    ok('already in sync');
    return;
  }
  renderTree(pull.sections);
  renderTree([buildSyncSummarySection(pull, pushOutcome)]);
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
    const result = await runPushCore();
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
 * Run the wet (real) sync: the pull half first, then the push half. A
 * pull-half fatal error is NOT caught here, so it propagates to `cmdSync`'s
 * own catch and the push half never runs. The pull half always returns the
 * `wet` tag when run without a preview flag, so the cast below carries no
 * risk.
 */
async function runSyncWet(): Promise<void> {
  const pull = runPullCore() as WetPull;
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
