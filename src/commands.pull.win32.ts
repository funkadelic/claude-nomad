/**
 * The win32-only pre-pull reconcile step, extracted from `commands.pull.ts` so
 * both halves of it (the additive mirror and the deletion pass) live beside each
 * other and neither file carries the whole thing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { yellow, warnGlyph } from './color.ts';
import { parsePorcelainZ } from './commands.pull.recovery.git.ts';
import { allSharedLinks, backupBase, deniedSegmentFor, type PathMap } from './config.ts';
import { gitProbe } from './git-probe.ts';
import {
  applySharedLinkDeletions,
  planSharedLinkDeletions,
  type SharedLinkDeletion,
} from './links.deletions.ts';
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
 * Whether two `sharedDirs` values describe the same configuration.
 *
 * The pre-rebase reconcile reports whether it already emitted this run's
 * `sharedDirs` rejection WARNs, so the post-rebase derivation can stay quiet
 * instead of repeating them. That report is only sound while both derivations
 * see the same field: the rebase in between can add, remove or replace entries,
 * and a suppression carried across it silences a derivation that had something
 * different to say. Two concrete failures, both reachable on win32: an invalid
 * entry the rebase DELIVERS is reported zero times (the pre-rebase map had
 * nothing to reject), and an entry the rebase REPLACES is reported under the old
 * spelling and never the new one.
 *
 * Compared by serialization rather than field-by-field because the field is
 * unvalidated runtime input: `validatePathMapShape` deliberately leaves it
 * alone, so it can be an array, a string, a number, or absent, and every one of
 * those shapes changes what `allSharedLinks` reports. Serializing compares them
 * all with one rule. Both absent serializes to `undefined` on both sides and
 * compares equal, which is the common case on a host with no `sharedDirs` at
 * all.
 *
 * @param before - The `sharedDirs` value the earlier derivation ran against.
 * @param after - The `sharedDirs` value the later derivation will run against.
 * @returns `true` when a WARN emitted about `before` also covers `after`.
 */
function sharedDirsUnchanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/**
 * Whether a pre-rebase derivation's `sharedDirs` rejection WARNs still cover
 * what a derivation against `map` would report, so the later one can stay quiet.
 *
 * Both halves have to hold. The earlier derivation must have happened at all
 * (it does not on darwin or linux, where the win32 reconcile returns
 * immediately, nor on an unreadable map), and the field it reported on must not
 * have moved. The rebase sits between the two, so it can add, remove or replace
 * `sharedDirs` entries; a suppression carried across that blindly hides an
 * entry the fetch just delivered, which reports it ZERO times, worse than the
 * duplicate the suppression exists to remove. See {@link sharedDirsUnchanged}.
 *
 * @param namesDerived - Whether the pre-rebase step derived the name list.
 * @param derivedSharedDirs - The `sharedDirs` value it derived against.
 * @param map - The post-rebase path-map the later derivation will read.
 * @returns `true` when the later derivation can safely be silenced.
 */
export function namesAlreadyReported(
  namesDerived: boolean,
  derivedSharedDirs: unknown,
  map: PathMap,
): boolean {
  return namesDerived && sharedDirsUnchanged(derivedSharedDirs, map.sharedDirs);
}

/**
 * The pre-rebase plans, re-stated against the POST-rebase map the preview will
 * actually describe.
 *
 * Only `namesDerived` can go stale across the rebase: the plans themselves are
 * deliberately computed against pre-rebase repo state (see
 * {@link SharedLinkPlans}), but the WARNs they claim to have already emitted
 * were emitted about a `sharedDirs` field the rebase may have since changed.
 *
 * Takes and returns `undefined` unchanged so the wet path, which computes no
 * plans, needs no branch of its own at the call site.
 *
 * @param plans - Plans from the pre-rebase `planSharedReconcileBeforePull`, or
 *   `undefined` on the wet path.
 * @param map - The post-rebase path-map the preview is rendered against.
 * @returns The same plans, with `namesDerived` re-evaluated against `map`.
 */
export function plansAgainst(
  plans: SharedLinkPlans | undefined,
  map: PathMap,
): SharedLinkPlans | undefined {
  if (plans === undefined) return undefined;
  return {
    ...plans,
    namesDerived: namesAlreadyReported(plans.namesDerived, plans.derivedSharedDirs, map),
  };
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
 * Repo-relative paths git reports as IGNORED under `shared/`, or an empty list
 * when the probe could not answer.
 *
 * A deliberately separate probe from the one {@link revertDeniedUnderShared}
 * acts on, and the separation is the point. `--ignored` makes git recurse into
 * every ignored subtree under `shared/` and emit a record per file, where
 * without it git prunes at the directory and never descends, so this is the
 * expensive half. Folding the flag into the single probe would put the whole
 * gate behind that walk: `gitProbe` collapses a timeout to `null`, the caller
 * returns, and a plainly untracked credential file the gate used to catch would
 * pass unreported and unmentioned. Run separately, a walk that times out costs
 * only the ignored half.
 *
 * `--untracked-files=all` travels with the flag so an ignored DIRECTORY expands
 * into its individual files, which is what makes the WARN name something the
 * user can act on rather than a directory to go searching through.
 *
 * @param repo - Absolute path to the sync repo.
 * @returns The ignored paths, or `[]` when git could not answer.
 */
function ignoredPathsUnderShared(repo: string): string[] {
  const out = gitProbe(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--', 'shared/'],
    repo,
  );
  if (out === null) return [];
  return out
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3));
}

/**
 * Report every IGNORED denylisted path under `shared/`, changing nothing.
 *
 * Report-only, and unlike the tracked half that is not about git being hard to
 * patch safely. An ignored path cannot leak. Every staging call in this
 * codebase is a plain `git add -A` or `git add -- <path>`, never `git add -f`,
 * and git will not stage an ignored path without it, so such a file cannot
 * reach the index, the gitleaks scan, a commit, or the remote by any route
 * nomad drives. Removing it would destroy user data to close nothing: the
 * pattern that hides it is one the user wrote, or worse one their GLOBAL
 * `core.excludesFile` supplies, and `.env`, `.npmrc`, `.netrc` and `credentials`
 * are all both on the never-sync list and near-universal in a developer's
 * global ignore file. So the WARN says where it is and leaves it there.
 *
 * @param repo - Absolute path to the sync repo.
 */
function reportIgnoredDenied(repo: string): void {
  for (const path of new Set(ignoredPathsUnderShared(repo))) {
    const segment = deniedSegmentFor(path);
    if (segment === null) continue;
    warn(
      `${path} is inside shared/ but git ignores it: the path segment "${segment}" is on the never-sync list. Nothing was changed, and nothing published it: nomad only ever stages with "git add -A", which skips an ignored path, so it has not reached the index or the remote. It stays invisible to the rest of this gate for the same reason, so move it outside shared/ if you want it kept, or delete it. Note the ignore rule may come from your global core.excludesFile rather than from this repo; run git check-ignore -v -- "${path}" to see which file and line the rule came from`,
    );
  }
}

/**
 * Run the denylist backstop over the repo working tree's `shared/` subtree.
 *
 * The sweep treats its halves differently, and
 * {@link revertDeniedMirrorPaths} owns the reasoning for the first two: an
 * untracked hit is snapshotted and then removed, while a tracked hit is
 * reported and left exactly as it was found. So a hit is always a WARN, and
 * only sometimes a write. {@link reportIgnoredDenied} adds a third, also
 * report-only, over the paths git ignores.
 *
 * Fed by a `git status` snapshot rather than the untracked-file diff the
 * reconcile already computes, because `git ls-files --others` only ever lists
 * untracked paths: a credential appended to an already-tracked
 * `shared/<name>` file appears in neither the before nor the after snapshot,
 * so that diff is empty for exactly the case this gate most needs to see.
 * `--untracked-files=all` is required too, since without it a wholly untracked
 * new subtree collapses to a single directory record, and per-file removal is
 * what the untracked half does.
 *
 * A `null` probe means git could not answer, and degrades to a silent skip:
 * remove nothing, report nothing, warn nothing. Every other `gitProbe` consumer
 * in this file has the same fail-open contract, and the removing half is why it
 * has to be this one: acting on an unanswerable snapshot is how a gate deletes
 * the wrong path, and a report built from the same snapshot would send the user
 * after the wrong one. The ignored pass runs either way, since it has its own
 * probe and never writes.
 *
 * @param repo - Absolute path to the sync repo.
 * @param ts - Backup timestamp, resolved once by `runPullCore`. Reaches only
 *   the untracked half, which is the only half that writes anything.
 */
function revertDeniedUnderShared(repo: string, ts: string): void {
  const out = gitProbe(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'shared/'],
    repo,
  );
  if (out !== null) revertDeniedMirrorPaths(repo, parsePorcelainZ(out), ts);
  reportIgnoredDenied(repo);
}

/**
 * One row's worth of content for the wet `Symlinks` section: either a mirror
 * capture or a deletion-pass removal, discriminated by `kind`. Both render
 * into the same section because they are the two halves of one pre-rebase
 * reconcile (see {@link reconcileSharedLinksBeforePull}).
 *
 * Module-private on purpose, following the precedent `DeniedRevertStatus`
 * sets in `src/links.mirror.ts`: it is only ever named positionally in
 * signatures declared in this same file, and exporting it would read as an
 * unused export to the dead-code analysis.
 */
type MirrorSectionEvent = MirrorPreviewEvent | SharedLinkDeletion;

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
 * under `dryRun` (zero-mutation preview contract), and when the caller reports
 * that a recovery actually ran, since `recoverForceRemote` ends in
 * `git reset --hard origin/main` and re-staging host content immediately after
 * that reset would undo it. The gate keys on the recovery having happened, NOT
 * on `--force-remote` being passed: the flag on a healthy repo, or on one
 * recovered from an unmerged index (`git reset --mixed HEAD`, which preserves
 * the working tree), leaves this pass running so an unpublished host edit is
 * still captured. Also a no-op when `path-map.json` is malformed.
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
 * invalid entry within a single pre-rebase reconcile. Both of those run at
 * this same point in the run, against this same pre-rebase repo state, so one
 * shared list is correct for them.
 *
 * The list itself is deliberately NOT returned. The post-rebase
 * `applySharedLinks` acts on the repo state the rebase left behind, so it has
 * to derive its own list from the post-rebase map; handing it this one would
 * freeze a pull that ADDS a `sharedDirs` entry (or its `shared/<name>`
 * content) to the names known before the fetch. What is returned instead is
 * `namesDerived`, which only tells the caller that this step already emitted
 * any `sharedDirs` rejection WARN for the run, so the post-rebase derivation
 * can be quiet rather than duplicating it.
 *
 * That claim expires at the rebase, so `derivedSharedDirs` comes back with it:
 * the raw `sharedDirs` value this step derived against. The caller compares it
 * to the post-rebase map's own before honoring the suppression, because a WARN
 * about the pre-rebase field says nothing about a field the rebase changed. See
 * {@link sharedDirsUnchanged}.
 *
 * @param repo - `repoHome()`, resolved once by `runPullCore`.
 * @param ts - Backup timestamp, resolved once by `runPullCore`.
 * @returns `mirrored` (repo-relative paths this run newly created under
 *   `shared/`), `events` (one entry per name the mirror copied AND one per
 *   repo file the deletion pass removed, in that order, matching the order
 *   `pull --dry-run`'s preview renders its `would capture` and `would remove`
 *   rows in), `namesDerived` (whether the shared-name list was derived here,
 *   and so whether its rejection WARNs have already been emitted), and
 *   `derivedSharedDirs` (the field those WARNs describe). All empty/false on
 *   darwin and linux; `mirrored` is also empty whenever the untracked-file
 *   snapshots could not be taken.
 */
export function reconcileSharedLinksBeforePull(
  repo: string,
  ts: string,
): {
  mirrored: string[];
  events: MirrorSectionEvent[];
  namesDerived: boolean;
  derivedSharedDirs: unknown;
} {
  if (process.platform !== 'win32') {
    return { mirrored: [], events: [], namesDerived: false, derivedSharedDirs: undefined };
  }
  const before = untrackedUnderShared(repo);
  const events: MirrorSectionEvent[] = [];
  let linkNames: string[] = [];
  let namesDerived = false;
  let derivedSharedDirs: unknown;
  try {
    const map = readMapForMirror(join(repo, 'path-map.json'));
    if (map !== null) {
      linkNames = allSharedLinks(map);
      namesDerived = true;
      derivedSharedDirs = map.sharedDirs;
    }
    stageLocalSharedEdits(map, ts, { onPreview: (e) => events.push(e), linkNames });
    events.push(...applySharedLinkDeletions(map, ts, { linkNames }));
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
  return {
    mirrored: newlyUntracked(before, untrackedUnderShared(repo)),
    events,
    namesDerived,
    derivedSharedDirs,
  };
}

/**
 * Build the wet-pull `Symlinks` section from the mirror and deletion events
 * collected by `reconcileSharedLinksBeforePull`. Reuses the `Symlinks` header
 * the dry-run preview tree already uses for the same concept (locked
 * decision: no third name for one idea). This section now covers both halves
 * of the pre-rebase reconcile: a `mirror` event renders the capture row it
 * always has, and a `deletion` event renders the past-tensed counterpart of
 * the dry-run `would remove` row, keeping the repo path first and the
 * parenthetical intact so the two tenses read as one event. Row text is past
 * tense throughout since both the copy and the removal already happened by
 * the time this renders.
 *
 * The row test names the deletion rather than the capture so that the capture
 * row is what an unrecognized event falls back to. A section that renders a
 * kind it does not know as a capture overstates what the run copied, which the
 * next pull corrects; rendering it as a removal tells the user a file left
 * their sync repo when nothing did, which is the claim nothing downstream can
 * walk back.
 *
 * @param events - Mirror and deletion events collected during the pre-rebase
 *   reconcile, in the order the reconcile produced them (captures, then
 *   removals).
 * @param discard - When the win32 mirror was legitimately skipped because
 *   recovery genuinely ran, the read-only tally of what it would have
 *   captured; see {@link describeSkippedMirrorDiscard}. Omitted, or `null`,
 *   on every other pull, in which case this section renders exactly as it
 *   did before this parameter existed.
 * @returns A `DoctorSection` with zero items when both `events` is empty and
 *   `discard` is absent, so `renderTree` omits it entirely and posix output
 *   stays byte-identical.
 */
export function buildMirrorSection(
  events: readonly MirrorSectionEvent[],
  discard?: MirrorDiscardSummary | null,
): DoctorSection {
  const s = section('Symlinks');
  for (const e of events) {
    addItem(
      s,
      e.kind === 'deletion'
        ? `removed  ${e.repoPath} (gone from ${e.localPath})`
        : `captured  ${e.localPath} -> ${e.repoPath}`,
    );
  }
  if (discard) {
    const names = discard.count === 1 ? 'name was' : 'names were';
    addItem(
      s,
      `${yellow(warnGlyph)} recovered from a wedged repo, ${discard.count} shared ${names} restored from the repo copy, previous host copies backed up to ${discard.backupPath}`,
    );
  }
  return s;
}

/**
 * The read-only tally `describeSkippedMirrorDiscard` returns: how many
 * shared names would have been captured by the pre-pull mirror this
 * recovery run skipped, and where their pre-overwrite bytes were snapshotted.
 *
 * The mirror performs no content comparison anywhere on this path, so `count`
 * is the number of shared names present on BOTH sides (host and repo), not
 * the number of names whose bytes actually differ. A host whose `~/.claude/`
 * already matches the repo still contributes its full shared-name count here.
 */
export type MirrorDiscardSummary = {
  /** Number of shared names present on both the host and the repo, counted
   * without any content comparison; not a count of changed files. */
  count: number;
  /** Absolute path under `~/.cache/claude-nomad/backup/<ts>/` holding the
   * pre-overwrite host-side bytes, the same location `applySharedLinksWin32`'s
   * own `backupBeforeWrite` call snapshots them to later in the same pull. */
  backupPath: string;
};

/**
 * Read-only counterpart to the mirror gate's skip: what
 * `reconcileSharedLinksBeforePull` WOULD have captured on this run, for
 * reporting only. Never writes anything, and never calls the wet form of the
 * mirror.
 *
 * `runPullCore` calls this only when `recovered` is `true`, i.e. only when
 * `recoverForceRemote` genuinely reset the repo to `origin/main` and the
 * mirror was therefore skipped to avoid fighting that reset. The count this
 * returns is the number of shared names present on both the host and the
 * repo, with NO content comparison anywhere on this path: it is not a count
 * of edited or changed files, and is a roughly constant number on a healthy
 * host whether or not the user changed anything. `applySharedLinksWin32`
 * backs each of those names up and then overwrites the host copy with the
 * repo's later in the same pull (see that function's own doc comment), and
 * until this helper existed nothing told the user that happened or where the
 * backup landed.
 *
 * Implemented by largely copying `planSharedReconcileBeforePull`'s call
 * shape: read the map via the same fail-safe reader, derive `linkNames`
 * once, and invoke `stageLocalSharedEdits` with its dry-run flag on and a
 * collecting `onPreview` sink. The dry-run flag is load-bearing and
 * non-negotiable: a second backup mechanism is explicitly out of scope, and
 * the wet form of the mirror would write. One deliberate difference from
 * that sibling: `linkNames` is derived with `{ quiet: true }` here, since
 * this is a report-only step and the post-rebase `applySharedLinks` owns
 * the `sharedDirs` rejection WARN for this pull.
 *
 * Wrapped in its own try/catch, degrading to `null` on any throw. This is a
 * reporting step on a recovery path, and a reporting step must never be the
 * thing that fails a pull; unlike `reconcileSharedLinksBeforePull`'s own
 * catch, this degrades silently rather than warning, since the user is
 * already being told about the recovery by `recoverForceRemote` itself and a
 * second failure line here would only be noise.
 *
 * The platform gate lives inside this helper (an early `null` return) so
 * `runPullCore` gains no platform branch of its own, matching how the mirror
 * gate itself already stays platform-agnostic.
 *
 * @param repo - `repoHome()`, already resolved once by `runPullCore`.
 * @param ts - Backup timestamp, already resolved once by `runPullCore`.
 * @returns `null` on darwin/linux, when nothing would have been captured, or
 *   when the computation itself threw; otherwise the count and backup path.
 */
export function describeSkippedMirrorDiscard(
  repo: string,
  ts: string,
): MirrorDiscardSummary | null {
  if (process.platform !== 'win32') return null;
  try {
    const map = readMapForMirror(join(repo, 'path-map.json'));
    // quiet: true, this is a report-only step. The post-rebase
    // `applySharedLinks` derives its own list against the post-rebase map and
    // owns the `sharedDirs` rejection WARN for this pull; deriving loudly here
    // duplicated that WARN.
    const linkNames = map !== null ? allSharedLinks(map, { quiet: true }) : undefined;
    const captures: MirrorPreviewEvent[] = [];
    stageLocalSharedEdits(map, ts, {
      dryRun: true,
      onPreview: (e) => captures.push(e),
      linkNames,
    });
    if (captures.length === 0) return null;
    return { count: captures.length, backupPath: join(backupBase(), ts) };
  } catch {
    return null;
  }
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
 * The shared-name list is derived ONCE here and threaded into both halves, for
 * the same reason the wet step does it: each half would otherwise derive its
 * own and re-emit every `sharedDirs` rejection WARN, so a user reading
 * `pull --dry-run` would count one rejected entry twice.
 *
 * The derivation is gated on win32, and the reason is the rebase rather than
 * the platform. Both halves return before deriving anything on darwin and
 * linux, so a derivation here would be pure WARN accounting; and because the
 * real rebase runs between this call and the preview that consumes the result,
 * that accounting would move posix's only rejection WARN off the preview's own
 * apply step, which reads the POST-rebase map, onto this one, which read the
 * map as it stood before the fetch. The user would be told about a `sharedDirs`
 * field the same command has already replaced.
 *
 * The sibling that renders those plans, `appendMirrorPlanRows` in `preview.ts`,
 * deliberately does the opposite and derives on EVERY platform. That is not a
 * contradiction: it only derives on the `nomad diff` path, which has no rebase
 * of its own, so its derivation and the apply's read the same map and there is
 * no stale field to report against.
 *
 * `derivedSharedDirs` travels with `namesDerived` for the same reason the wet
 * step returns it: `pull --dry-run` runs the real rebase between this call and
 * the preview that consumes the result, so the suppression is only sound while
 * the field the WARNs are about has not moved.
 *
 * @param repo - `repoHome()`, resolved once by the caller.
 * @param ts - Backup timestamp, resolved once by the caller; unused for
 *   mutation under `dryRun`, only for event phrasing.
 * @returns The capture and deletion plans for the current repo state, plus
 *   `namesDerived` (see {@link SharedLinkPlans}).
 */
export function planSharedReconcileBeforePull(repo: string, ts: string): SharedLinkPlans {
  const map = readMapForMirror(join(repo, 'path-map.json'));
  const captures: MirrorPreviewEvent[] = [];
  const linkNames = process.platform === 'win32' && map !== null ? allSharedLinks(map) : undefined;
  stageLocalSharedEdits(map, ts, { dryRun: true, onPreview: (e) => captures.push(e), linkNames });
  return {
    captures,
    deletions: planSharedLinkDeletions(map, { linkNames }),
    namesDerived: linkNames !== undefined,
    derivedSharedDirs: map?.sharedDirs,
  };
}
