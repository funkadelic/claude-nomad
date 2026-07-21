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
import { HOST, repoHome } from './config.ts';
import { dim, infoGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, renderTree, section, type DoctorSection } from './output-tree.ts';
import { die, fail, log, ok, NomadFatal } from './utils.ts';
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
 * Build the pull-half summary row from outcome data: whether the rebase
 * actually moved `REPO_HOME`'s HEAD (`incomingChanges`), naming the settings
 * override-source label regenerated on every pull regardless of whether
 * anything came in.
 *
 * @param pull - The wet pull result.
 * @returns The `pull: ...` row text (no leading glyph).
 */
function buildPullSummaryRow(pull: WetPull): string {
  const applied = pull.incomingChanges ? 'upstream changes applied' : 'no upstream changes';
  return `pull: ${applied}; settings regenerated (base + ${pull.settingsLabel})`;
}

/**
 * Render a count with a count-aware noun, e.g. `1 config file` vs
 * `2 config files`.
 *
 * @param n - The count (caller guarantees nonzero for summary rows).
 * @param singular - The noun phrase used when `n` is exactly 1.
 * @param plural - The noun phrase used otherwise.
 * @returns The `<n> <noun>` phrase.
 */
function countNoun(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Build the nonzero parenthetical parts for a successful `push: pushed` row:
 * the pull half's `localOnly`/`divergedKeptLocal` counts plus the push
 * half's `globalConfigCount`, each included only when nonzero.
 *
 * @param pull - The wet pull result.
 * @param globalConfigCount - The push half's changed-config-file count.
 * @returns Zero or more phrase fragments, e.g. `2 local-only sessions`.
 */
function pushedParenParts(pull: WetPull, globalConfigCount: number): string[] {
  const parts: string[] = [];
  if (pull.localOnly > 0) {
    parts.push(countNoun(pull.localOnly, 'local-only session', 'local-only sessions'));
  }
  if (pull.divergedKeptLocal > 0) {
    parts.push(countNoun(pull.divergedKeptLocal, 'diverged extras file', 'diverged extras files'));
  }
  if (globalConfigCount > 0) {
    parts.push(countNoun(globalConfigCount, 'config file', 'config files'));
  }
  return parts;
}

/**
 * Build the push-half summary row: `push: pushed` with a parenthetical of
 * only the nonzero reconciled-work parts (omitted entirely when every part
 * is zero), or `push: nothing to push` on the `nothing` or defensive `dry`
 * tag (a wet sync's push half never actually returns `dry`; see the
 * `pushSectionsOf` JSDoc).
 *
 * @param pull - The wet pull result.
 * @param result - The push half's successful `PushCoreResult`.
 * @returns The `push: ...` row text (no leading glyph).
 */
function buildPushSummaryRow(pull: WetPull, result: PushCoreResult): string {
  if (result.tag !== 'pushed') return 'push: nothing to push';
  const parts = pushedParenParts(pull, result.globalConfigCount ?? 0);
  return parts.length > 0 ? `push: pushed (${parts.join(', ')})` : 'push: pushed';
}

/**
 * Build the collapsed skip/warn info rows appended after the pull/push rows:
 * a combined not-in-path-map count, an extras-skipped count, and a
 * push-collision count, each present only when nonzero.
 *
 * @param pull - The wet pull result.
 * @param result - The push half's successful `PushCoreResult`.
 * @returns Zero or more info/warn row strings.
 */
function buildSkipAndCollisionRows(pull: WetPull, result: PushCoreResult): string[] {
  const rows: string[] = [];
  if (pull.unmapped > 0) {
    rows.push(`${dim(infoGlyph)} ${pull.unmapped} not in path-map (run nomad doctor to list)`);
  }
  if (pull.extrasSkipped > 0) {
    rows.push(`${dim(infoGlyph)} ${pull.extrasSkipped} extras skipped`);
  }
  const collisions = result.tag === 'dry' ? undefined : result.collisions;
  if (collisions !== undefined && collisions > 0) {
    const phrase = countNoun(collisions, 'collision', 'collisions');
    rows.push(`${yellow(warnGlyph)} ${phrase} (run nomad doctor to list)`);
  }
  return rows;
}

/**
 * Build the two-phase status Sync summary section: composed entirely from
 * outcome data on both halves rather than quoting either half's own rendered
 * summary row (the old behavior quoted the pull half's `Pull summary` row
 * verbatim, carrying stale `(push to reconcile)` advice into a run that had
 * already pushed). On a failed push half this collapses to the single status
 * line naming which half failed; on a successful run it composes the pull
 * row, the push row (whose parenthetical already names the reconciled-work
 * counts), a committed-but-unpushed note when the push half reported
 * `aheadOfOrigin`, and the collapsed skip/warn info rows.
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
  const { result } = pushOutcome;
  addItem(s, buildPullSummaryRow(pull));
  addItem(s, buildPushSummaryRow(pull, result));
  if (result.tag === 'nothing' && result.aheadOfOrigin === true) {
    addItem(s, 'sync repo has unpushed commits');
  }
  for (const row of buildSkipAndCollisionRows(pull, result)) addItem(s, row);
  return s;
}

/**
 * Canonical merged-tree section order: the pull-owned Settings leads, then
 * the push-only Global config, the merged Sessions/Extras, and the push-only
 * Leak scan. The caller appends the Sync summary after these.
 */
const SYNC_SECTION_ORDER = ['Settings', 'Global config', 'Sessions', 'Extras', 'Leak scan'];

/**
 * True for the per-half summary headers dropped from the merged tree: the
 * single Sync summary replaces both. Dropping by name (rather than dropping
 * everything outside `SYNC_SECTION_ORDER`) means a section header added to a
 * half's builder later still reaches `nomad sync` output instead of
 * vanishing silently. A function rather than a module-level set so the
 * constant is read lazily, not at import time.
 *
 * @param header - A section header from either half.
 * @returns `true` when the header is one of the two dropped summaries.
 */
function isDroppedSummaryHeader(header: string): boolean {
  return header === PULL_SUMMARY_HEADER || header === 'Push summary';
}

/**
 * Merge the pull half's and push half's built sections into one tree: the
 * `Pull summary` (`PULL_SUMMARY_HEADER`) and `Push summary` sections are
 * dropped by name (the single Sync summary replaces both), the remaining
 * sections are grouped by header in `SYNC_SECTION_ORDER` with any header
 * outside that canonical list appended after it in first-seen order (the
 * `Map` preserves insertion order, so unknown headers render last instead of
 * being discarded), and within each header the items from both halves are
 * concatenated de-duplicated by exact string value in first-seen order (so
 * the byte-identical `not in path-map` skip row both halves emit collapses
 * to one).
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
    if (isDroppedSummaryHeader(s.header)) continue;
    let target = byHeader.get(s.header);
    if (target === undefined) {
      target = section(s.header);
      byHeader.set(s.header, target);
    }
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
 * followed by the two-phase status Sync summary. By default (compact,
 * matching `nomad doctor`'s compact-by-default precedent) only the Sync
 * summary prints; under `verbose`, ONE merged grouped tree (both halves'
 * sections merged in pull-then-push canonical order, each duplicated fact
 * stated once) renders first. Both halves ran in compose mode, so nothing
 * has rendered before this function; it owns the entire output.
 *
 * @param pull - The wet pull result.
 * @param pushOutcome - The push half's outcome.
 * @param verbose - When `true`, render the full merged tree before the summary.
 */
function renderWetSync(pull: WetPull, pushOutcome: PushOutcome, verbose: boolean): void {
  if (isNoopSync(pull, pushOutcome)) {
    ok('already in sync');
    return;
  }
  log(`sync on host=${HOST}`);
  const summary = buildSyncSummarySection(pull, pushOutcome);
  if (!verbose) {
    renderTree([summary]);
    return;
  }
  const merged = mergeSyncSections(pull.sections, pushSectionsOf(pushOutcome));
  renderTree([...merged, summary]);
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
      process.exitCode = err.code;
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
 *
 * @param verbose - Threaded into `renderWetSync`; see its JSDoc.
 */
async function runSyncWet(verbose: boolean): Promise<void> {
  const pull = runPullCore({ compose: true }) as WetPull;
  const pushOutcome = await runSyncPushHalf();
  renderWetSync(pull, pushOutcome, verbose);
}

/**
 * Run the dry-run preview: the pull half's own dry path first, then a
 * one-line caveat that the push preview below is computed against pre-pull
 * state (a real sync pushes after the pull half applies), then the push
 * half's own preview.
 *
 * Delegating to `runPullCore({ dryRun: true })` rather than calling
 * `computePreview` directly is load-bearing, not a tidy-up. It gives the pull
 * preview the three properties standalone `nomad pull --dry-run` has and the
 * direct-`computePreview` version lacked:
 *
 * 1. the preview is computed AFTER `runPullCore`'s own `git pull --rebase
 *    --autostash`, so it describes what a real sync would apply instead of
 *    the pre-fetch repo state (the push half fetches too, so the old order
 *    rendered a preview of commits it was about to pull in anyway);
 * 2. `handleWedge` runs as a preflight, so a repo stuck mid-rebase or
 *    mid-merge dies with the runbook instead of rendering a tree derived
 *    from a conflicted working tree;
 * 3. `divergenceCheckExtras` runs, so the both-sides-modified and
 *    delete-vs-edit keep-local WARNs a wet `nomad sync` emits are present in
 *    the preview too (the same preview/wet gap already closed for
 *    `nomad diff`).
 *
 * Both halves still perform a network round-trip (`runPullCore`'s rebase and
 * `runPushCore`'s `rebaseBeforePush`), which is the documented
 * `pull --dry-run` / `push --dry-run` contract, not a mutation escape.
 * Neither half writes to `~/.claude/`, and neither stages, commits, or
 * pushes. `REPO_HOME` is NOT untouched, though: both rebases advance it onto
 * its upstream, so the worktree there can change. "Dry" scopes to the live
 * config and to publishing, not to the sync repo's git state.
 *
 * The single closing line is emitted here rather than by either half:
 * `runPullCore` deliberately leaves it to its caller (see the dry branch
 * there), so the only 'complete' line a user sees is the one that actually
 * ends the command.
 */
async function runSyncDryRun(): Promise<void> {
  runPullCore({ dryRun: true });
  log('push preview below is computed against pre-pull state (a real sync pushes after pull)');
  await runPushCore({ dryRun: true });
  log('dry-run complete; nothing applied to ~/.claude/, nothing pushed');
}

/**
 * `nomad sync` command. Acquires a single lock spanning both halves, runs the
 * pull half then the push half (or, under `dryRun`, both previews), and
 * releases the lock. A fatal error from either half sets
 * `process.exitCode = 1`; the `finally` block guarantees the lock is
 * released even when a half throws.
 *
 * @param opts.dryRun - Preview mode: stacks the pull preview then the push
 *   preview. It writes nothing to `~/.claude/` and stages/commits/pushes
 *   nothing, but it is NOT a zero-side-effect run: both halves perform a
 *   real network round-trip and rebase `REPO_HOME` onto its upstream
 *   (`runPullCore`'s `git pull --rebase --autostash` and `runPushCore`'s
 *   `rebaseBeforePush`). That is the deliberate, documented
 *   `pull --dry-run` / `push --dry-run` contract: a preview computed against
 *   pre-fetch state would describe a sync nobody is about to run.
 * @param opts.verbose - Wet-path only: render the full merged tree before
 *   the Sync summary (default renders the Sync summary alone).
 */
export async function cmdSync(opts: { dryRun?: boolean; verbose?: boolean } = {}): Promise<void> {
  const dryRun = opts.dryRun === true;
  const verbose = opts.verbose === true;
  // Resolve roots once per command invocation (TOCTOU mitigation, mirrors
  // cmdPull/cmdPush).
  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);
  if (!existsSync(join(repo, 'shared', 'settings.base.json'))) {
    die("repo not initialized; run 'nomad init' to scaffold");
  }
  const handle = acquireLock('sync');
  if (handle === null) process.exit(0);
  try {
    if (dryRun) {
      await runSyncDryRun();
    } else {
      await runSyncWet(verbose);
    }
  } catch (err) {
    if (err instanceof NomadFatal) {
      fail(err.message);
      process.exitCode = err.code;
    } else {
      throw err;
    }
  } finally {
    releaseLock(handle);
  }
}
