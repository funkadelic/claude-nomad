/**
 * The win32-only pre-pull reconcile step, extracted from `commands.pull.ts` so
 * both halves of it (the additive mirror and the deletion pass) live beside each
 * other and neither file carries the whole thing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parsePorcelainZ } from './commands.pull.recovery.git.ts';
import { allSharedLinks, type PathMap } from './config.ts';
import { gitProbe } from './git-probe.ts';
import { applySharedLinkDeletions, planSharedLinkDeletions } from './links.deletions.ts';
import {
  revertDeniedMirrorPaths,
  stageLocalSharedEdits,
  type MirrorPreviewEvent,
} from './links.mirror.ts';
import { addItem, section, type DoctorSection } from './output-tree.ts';
import { type SharedLinkPlans } from './preview.ts';
import { warn } from './utils.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Read `path-map.json` for the win32 pre-pull reconcile, fail-safe.
 *
 * An ABSENT file yields `{ projects: {} }`, matching what `runPullCore` itself
 * falls back to further down. `allSharedLinks({ projects: {} })` is exactly the
 * static `SHARED_LINKS` set, which is all the reconcile needs, so a host whose
 * repo has no `path-map.json` yet (a clone that predates `nomad init`) still
 * gets its unpublished shared-config edits staged rather than silently reverted.
 *
 * Only an unreadable or MALFORMED file yields `null`, which both passes treat as
 * "skip me". Deliberately does NOT reuse the `readPathMap` call further down
 * `runPullCore`: that one runs after the rebase and dies fatally on a parse
 * error, which is the right behavior for the pull proper but wrong for a
 * pre-step that must never be the thing that fails a pull.
 *
 * @param mapPath - Absolute path to `REPO_HOME/path-map.json`.
 * @returns The parsed path-map, or `null` when it exists but cannot be parsed.
 */
function readMapForMirror(mapPath: string): PathMap | null {
  if (!existsSync(mapPath)) return { projects: {} };
  try {
    return readPathMap(mapPath);
  } catch {
    return null;
  }
}

/**
 * Snapshot the untracked paths under `shared/` in the repo working tree.
 *
 * Taken once before the mirror and once after, the pair identifies exactly what
 * this run wrote: nomad knows what it copied, so a set difference answers the
 * question outright where matching against git's stderr later would be guessing
 * at prose. Anything already untracked before the run (a file the user put in
 * the repo by hand, a leftover from an earlier session) is in the BEFORE
 * snapshot and is therefore never attributed to this run.
 *
 * Repo-relative, forward-slashed, and in git's own order on every platform,
 * because `ls-files` normalizes all three. `-z` keeps a path with a space or a
 * quote intact, which git's default output would have quoted and escaped.
 *
 * @param repo - Absolute path to the sync repo.
 * @returns The untracked paths, or `null` when the probe could not answer, which
 *   callers treat as "cannot attribute anything to this run".
 */
function untrackedUnderShared(repo: string): Set<string> | null {
  const out = gitProbe(['ls-files', '--others', '--exclude-standard', '-z', '--', 'shared/'], repo);
  if (out === null) return null;
  return new Set(out.split('\0').filter((p) => p !== ''));
}

/**
 * The paths in `after` that were not already in `before`.
 *
 * An unanswerable snapshot on either side yields the empty set rather than a
 * guess. That deliberately turns the whole created-set feature off for the run
 * (the caller then behaves exactly as it did before the feature existed), which
 * is the right degradation: the alternative reading, treating a missing BEFORE
 * as "nothing was untracked", would attribute the user's own pre-existing files
 * to this run and put them in line for removal.
 *
 * @param before - Snapshot taken before the mirror ran.
 * @param after - Snapshot taken after the mirror ran.
 * @returns Repo-relative paths this run created, in git's order.
 */
function newlyUntracked(before: Set<string> | null, after: Set<string> | null): string[] {
  if (before === null || after === null) return [];
  return [...after].filter((p) => !before.has(p));
}

/**
 * Run the denylist backstop over the repo working tree's `shared/` subtree.
 *
 * Fed by a `git status` snapshot rather than the untracked-file diff the
 * reconcile already computes, because `git ls-files --others` only ever lists
 * untracked paths: a credential appended to an already-tracked
 * `shared/<name>` file appears in neither the before nor the after snapshot,
 * so that diff is empty for exactly the case this gate most needs to see.
 * `--untracked-files=all` is required too, since without it a wholly untracked
 * new subtree collapses to a single directory record and the per-file revert
 * has nothing to act on.
 *
 * A `null` probe means git could not answer, and degrades to a silent skip:
 * revert nothing, warn nothing. Every other `gitProbe` consumer in this file
 * has the same fail-open contract, and inventing a revert from an unanswerable
 * snapshot is how a gate deletes the wrong path.
 *
 * @param repo - Absolute path to the sync repo.
 * @param ts - Backup timestamp, resolved once by `runPullCore`.
 */
function revertDeniedUnderShared(repo: string, ts: string): void {
  const out = gitProbe(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'shared/'],
    repo,
  );
  if (out === null) return;
  const { tracked, untracked } = parsePorcelainZ(out);
  revertDeniedMirrorPaths(repo, tracked, untracked, ts);
}

/**
 * win32-only pre-pull step: make the host's own shared-config state visible in
 * the repo working tree BEFORE `git pull --rebase --autostash` runs, in both
 * directions. Additions and edits are staged into `shared/<name>`; files the
 * user deleted are removed from it.
 *
 * On posix a shared name is a symlink, so an edit to `~/.claude/CLAUDE.md` is
 * ALREADY an uncommitted change in the repo working tree when a pull starts, and
 * a file deleted inside a shared directory is ALREADY gone from the repo. The
 * autostash carries both through the rebase, `applySharedLinks` re-points the
 * same symlink, and the state is unchanged afterwards. Pull-first costs a posix
 * user nothing.
 *
 * On win32 both live only in the host-side copy. Without the mirror,
 * `applySharedLinksWin32` overwrites an edit from the repo and it survives only
 * in the backup dir; under `nomad sync` the push half then published the
 * reverted content, silently undoing the change the user ran sync to publish.
 * Without the deletion pass the mirror alone is not enough either: it is
 * additive, so the repo keeps the deleted file and the repo-to-local overlay
 * later in the same pull puts it straight back on the host.
 *
 * The deletion half is gated on the per-host baseline, which is what makes a
 * deletion distinguishable from a file this host has never received; a host with
 * no trustworthy baseline propagates no removals at all. See
 * `links.baseline.ts`.
 *
 * The mirror's write is deliberately narrower than the push mirror (no new
 * shared names, overlay rather than replace, repo-side backup first); see
 * `stageLocalSharedEdits` for why a pull cannot reuse the push policy.
 *
 * Skipped in three cases: on darwin/linux (both passes return immediately),
 * under `dryRun` (zero-mutation preview contract), and under `forceRemote`,
 * which is the deliberate "discard local, take the remote" escape hatch
 * (`recoverForceRemote` resets to `origin/main`) that reconciling host content
 * in would fight. Also a no-op when `path-map.json` is malformed.
 *
 * The map is read ONCE and shared by both passes, so they cannot disagree about
 * which names are shared. Mirror first, then deletions, so the backup cache
 * records the two in a stable order.
 *
 * Reports what the mirror ADDED to the repo working tree, so the caller can
 * tell the user's own files apart from the copies this run made if the fetch
 * that follows refuses to overwrite one of them. The snapshots bracket both
 * passes, including the containment below: a mirror that throws part way can
 * still have written files, and those are this run's to account for.
 *
 * `events` is collected via an `onPreview` sink passed into
 * `stageLocalSharedEdits`, and is what lets a wet pull render a `Symlinks` row
 * naming what the mirror captured. It answers a different question than
 * `mirrored`: `mirrored` is the flat set of repo-relative paths this run
 * newly created (from the untracked-file snapshot diff, used by the collision
 * runbook), while `events` is one entry per name the mirror actually copied,
 * whether or not the repo-side path was already tracked.
 *
 * `linkNames` is derived here ONCE (`allSharedLinks(map)`, when `map` is
 * non-null) and threaded into both `stageLocalSharedEdits` and
 * `applySharedLinkDeletions`, which otherwise each derive it independently and
 * would double- or triple-emit a `sharedDirs` rejection WARN for the same
 * invalid entry within a single pre-rebase reconcile. It is also returned so
 * `runPullCore` can thread the SAME list into the post-rebase
 * `applySharedLinks` call, making one derivation cover the entire wet pull.
 *
 * @param repo - `repoHome()`, resolved once by `runPullCore`.
 * @param ts - Backup timestamp, resolved once by `runPullCore`.
 * @returns `mirrored` (repo-relative paths this run newly created under
 *   `shared/`), `events` (one `MirrorPreviewEvent` per name the mirror
 *   copied), and `linkNames` (the derived name list, empty when `map` could
 *   not be read). All empty on darwin and linux; `mirrored` is also empty
 *   whenever the untracked-file snapshots could not be taken.
 */
export function reconcileSharedLinksBeforePull(
  repo: string,
  ts: string,
): { mirrored: string[]; events: MirrorPreviewEvent[]; linkNames: string[] } {
  if (process.platform !== 'win32') return { mirrored: [], events: [], linkNames: [] };
  const before = untrackedUnderShared(repo);
  const events: MirrorPreviewEvent[] = [];
  let linkNames: string[] = [];
  try {
    const map = readMapForMirror(join(repo, 'path-map.json'));
    if (map !== null) linkNames = allSharedLinks(map);
    stageLocalSharedEdits(map, ts, { onPreview: (e) => events.push(e), linkNames });
    applySharedLinkDeletions(map, ts, { linkNames });
  } catch (err) {
    // A pre-step must never be the thing that fails a pull. Either pass can
    // throw for reasons unrelated to the user's intent (a path over the Windows
    // limit, an antivirus lock, EPERM on a read-only repo file), and letting
    // that propagate would abort before `git pull --rebase` runs, leaving the
    // host unable to fetch at all until the local condition clears. Warn and
    // continue: the unstaged edit is still on the host, applySharedLinksWin32
    // backs it up again before overwriting it, and an unpropagated deletion is
    // simply replanned on the next run.
    warn(`could not reconcile local shared edits before the pull: ${(err as Error).message}`);
  }
  // Outside the try on purpose: a pass that threw part way can still have
  // written, so the gate has to see the tree as it actually stands. Before the
  // "after" snapshot, so a path it removed is not then reported as one this run
  // created.
  revertDeniedUnderShared(repo, ts);
  return { mirrored: newlyUntracked(before, untrackedUnderShared(repo)), events, linkNames };
}

/**
 * Build the wet-pull `Symlinks` section from the mirror events collected by
 * `reconcileSharedLinksBeforePull`. Reuses the `Symlinks` header the dry-run
 * preview tree already uses for the same concept (locked decision: no third
 * name for one idea). Row text is past tense since the copy already happened
 * by the time this renders.
 *
 * @param events - Mirror events collected during the pre-rebase reconcile.
 * @returns A `DoctorSection` with zero items when `events` is empty, so
 *   `renderTree` omits it entirely and posix output stays byte-identical.
 */
export function buildMirrorSection(events: readonly MirrorPreviewEvent[]): DoctorSection {
  const s = section('Symlinks');
  for (const e of events) {
    addItem(s, `captured  ${e.localPath} -> ${e.repoPath}`);
  }
  return s;
}

/**
 * The read-only counterpart of {@link reconcileSharedLinksBeforePull}: what
 * that step WOULD do, for a caller previewing instead of applying.
 *
 * Exists so `pull --dry-run` can compute both plans at the same point in the
 * run the wet reconcile acts, which is before the rebase. Both the deletion
 * planner and the dry-run mirror gate on repo-side existence, so computing
 * them after the rebase would let the preview and the run disagree about a
 * file the rebase deleted or added upstream.
 *
 * The capture half runs the real mirror (`stageLocalSharedEdits`) under
 * `dryRun: true` with a collecting `onPreview` sink, instead of a separate
 * predictor: this is the single source `computePreview` and a real pull share,
 * so a gate added to one can no longer be missed on the other. No disk
 * mutation occurs under `dryRun`, so `ts` here is only ever used for event
 * phrasing, matching `applySharedLinks`'s existing `dryRun` contract.
 *
 * Reads the map through the same fail-safe reader the wet step uses, so the two
 * cannot disagree about which names are shared, and returns empty plans on
 * darwin and linux because both sources do.
 *
 * @param repo - `repoHome()`, resolved once by the caller.
 * @param ts - Backup timestamp, resolved once by the caller; unused for
 *   mutation under `dryRun`, only for event phrasing.
 * @returns The capture and deletion plans for the current repo state.
 */
export function planSharedReconcileBeforePull(repo: string, ts: string): SharedLinkPlans {
  const map = readMapForMirror(join(repo, 'path-map.json'));
  const captures: MirrorPreviewEvent[] = [];
  stageLocalSharedEdits(map, ts, { dryRun: true, onPreview: (e) => captures.push(e) });
  return { captures, deletions: planSharedLinkDeletions(map) };
}
