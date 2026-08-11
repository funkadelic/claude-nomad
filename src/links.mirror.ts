/**
 * The win32-only host-to-repo mirror, extracted from `links.ts` so the
 * host->repo write half lives beside itself and `links.ts` no longer carries
 * the whole thing.
 */

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  deniedSegmentFor,
  repoHome,
  NEVER_SYNC,
  type PathMap,
} from './config.ts';
import { copyExtrasFiltered, copyExtrasOverlayFiltered } from './extras-sync.core.ts';
import { gitProbe, gitTryMutate } from './git-probe.ts';
import { log, warn } from './utils.ts';
import { backupRepoWrite } from './utils.fs.ts';

/**
 * Event emitted by the win32 host-to-repo mirror (`stageLocalSharedEdits`,
 * `syncSharedLinksPush`) when a sink is supplied: on the dry-run path via
 * `emitMirror`, and on the wet path right after the copy lands. Shaped after
 * the mirror's own capture record (`name`, `localPath`, `repoPath`) rather
 * than the posix `LinkPreviewEvent`'s `from`/`to` pair, since this event is
 * the single source for both the wet-pull `Symlinks` row and the dry-run
 * preview row.
 */
export type MirrorPreviewEvent = {
  kind: 'mirror';
  /** The shared name (`CLAUDE.md`, `commands`, ...). */
  name: string;
  /** Absolute host-side path (`~/.claude/<name>`), the copy source. */
  localPath: string;
  /** Absolute repo-side path (`shared/<name>`), the copy destination. */
  repoPath: string;
};

/**
 * Options shared by every mirror entry point. `linkNames`, when supplied,
 * is used verbatim instead of deriving the name list internally; this is
 * what lets a caller derive `allSharedLinks(map)` once per command
 * invocation instead of once per mirror call, so an invalid `sharedDirs`
 * entry WARNs exactly once per `nomad pull` or `nomad push` rather than
 * once per call site.
 */
type MirrorOpts = {
  /** When `true`, no disk mutation occurs; see `emitMirror`. */
  dryRun?: boolean;
  /** Structured-event sink; see `MirrorPreviewEvent`. */
  onPreview?: (e: MirrorPreviewEvent) => void;
  /** Pre-derived name list; falls back to `allSharedLinks(map)` when absent. */
  linkNames?: readonly string[];
};

/**
 * Emit a dry-run mirror event via `onPreview`, or fall back to `log()` when
 * no sink is supplied. Mirrors `emitCopy`'s fallback shape in `links.ts`.
 */
function emitMirror(
  onPreview: MirrorOpts['onPreview'],
  name: string,
  localPath: string,
  repoPath: string,
): void {
  if (onPreview) {
    onPreview({ kind: 'mirror', name, localPath, repoPath });
  } else {
    log(`would capture: ${localPath} -> ${repoPath}`);
  }
}

/**
 * Emit the wet-path mirror event when a sink is supplied. Deliberately no
 * `log()` fallback: a wet run with no sink attached must stay byte-silent, so
 * `syncSharedLinksPush(map)`'s existing call site and every direct-call test
 * are unaffected by this event's introduction.
 */
function emitMirrorWet(
  onPreview: MirrorOpts['onPreview'],
  name: string,
  localPath: string,
  repoPath: string,
): void {
  if (onPreview) onPreview({ kind: 'mirror', name, localPath, repoPath });
}

/**
 * The `git status` snapshot {@link revertDeniedMirrorPaths} acts on, structurally
 * matching what `parsePorcelainZ` (`commands.pull.recovery.git.ts`) returns.
 *
 * Declared here rather than imported so this module stays a leaf of that one:
 * `commands.pull.win32.ts` already depends on both, and the parser has no
 * business knowing about the backstop that consumes it. `renameSources` is
 * optional so a caller with only the two path arrays (every direct-call test of
 * a plain add or removal) needs no third field.
 */
export type DeniedRevertStatus = {
  /** Repo-relative tracked paths, including both halves of a rename. */
  tracked: readonly string[];
  /** Repo-relative untracked paths. */
  untracked: readonly string[];
  /** Rename/copy destination path to the source path the same record consumed. */
  renameSources?: Readonly<Record<string, string>>;
};

/** How one mirror pass treats the repo side. See the two exported wrappers. */
type SharedMirrorPolicy = {
  /** Create `shared/<name>` when the repo has no counterpart yet. */
  adoptNew: boolean;
  /** Overlay onto the repo copy instead of replacing it wholesale. */
  overlay: boolean;
  /** When set, snapshot the repo copy under `backup/<ts>/repo/` before writing. */
  backupTs?: string;
};

/**
 * Mirror one `~/.claude/<name>` into `shared/<name>` under `policy`. Extracted
 * from the loop so each of the two wrappers stays readable and the per-name
 * branch set stays well inside the cognitive-complexity threshold.
 *
 * Under `opts.dryRun`, no disk mutation occurs at all: the event is emitted
 * (via `emitMirror`) INSTEAD of copying, and no `backupRepoWrite` call fires
 * either. On the wet path, the copy happens first and the event is emitted
 * afterward only when `opts.onPreview` is supplied (`emitMirrorWet`).
 *
 * The copy filter runs against the full `NEVER_SYNC` set. Every path this
 * mirror writes lives under `shared/<name>` and never under `shared/extras/`,
 * so `blockSetFor` resolves such a path to `NEVER_SYNC` unconditionally: this
 * computes, at copy time and with no git invocation, exactly the gate the
 * repo-working-tree backstop computes for the same path afterwards. The point
 * is that the path is simply never written, leaving the backstop a genuine
 * second layer rather than the only line of defense.
 *
 * The trade-off is real and deliberate. `NEVER_SYNC` is not a generic secrets
 * list: it was authored against `~/.claude/`'s own directory semantics and
 * carries ordinary-sounding names (`todos`, `shell-snapshots`, `debug`,
 * `file-history`, `plans`, `session-env`, `statsig`, `telemetry`, `ide`,
 * `cache`, `backups`, `paste-cache`, `daemon`, `jobs`, `tasks`, `security`,
 * `sessions`). A user whose `sharedDirs` content legitimately contains a
 * directory spelled exactly like one of those stops seeing it mirrored.
 * `isDeniedName` matches whole segments, not substrings, so a FILE named
 * `tasks.md` is unaffected; only a path segment spelled exactly `tasks`
 * collides.
 *
 * The stat is wrapped in its own try/catch because `throwIfNoEntry: false`
 * suppresses ENOENT only; EACCES, EPERM and EIO still throw. Since the preview
 * path (`computePreview` in `preview.ts`) now calls this mirror directly, with
 * no enclosing try/catch of its own, an unreadable local path must degrade to
 * one skipped name rather than crash `nomad diff`/`pull --dry-run`, whose
 * whole value is being safe to run. On the wet path this also narrows the
 * blast radius of a locked file from aborting the entire mirror pass (the
 * outer catch in `reconcileSharedLinksBeforePull`) to skipping just this name.
 *
 * @param name - Shared name from `allSharedLinks`.
 * @param claude - `claudeHome()`, resolved once by the caller.
 * @param repo - `repoHome()`, resolved once by the caller.
 * @param policy - Repo-side treatment; see {@link SharedMirrorPolicy}.
 * @param opts - `dryRun`/`onPreview`; see {@link MirrorOpts}.
 */
function mirrorOneSharedName(
  name: string,
  claude: string,
  repo: string,
  policy: SharedMirrorPolicy,
  opts: MirrorOpts,
): void {
  const localPath = join(claude, name);
  let stat;
  try {
    stat = lstatSync(localPath, { throwIfNoEntry: false });
  } catch {
    return; // unreadable: the mirror cannot promise anything about it
  }
  if (stat === undefined) return; // absent: nothing to mirror
  if (stat.isSymbolicLink()) return; // symlink-era live link; defer to next pull
  const target = join(repo, 'shared', name);
  if (!policy.adoptNew && !existsSync(target)) return; // repo does not share this name

  if (opts.dryRun === true) {
    emitMirror(opts.onPreview, name, localPath, target);
    return;
  }

  if (policy.backupTs !== undefined) backupRepoWrite(target, policy.backupTs, repo);
  // Overlay is directory-only (`copyExtrasOverlayFiltered` walks the source with
  // readdirSync). A SHARED_LINKS FILE entry like CLAUDE.md has no repo-only
  // sibling to preserve in the first place, so the plain filtered copy IS the
  // overlay for it, and routing files here keeps the primitive's contract intact.
  if (policy.overlay && stat.isDirectory()) {
    copyExtrasOverlayFiltered(localPath, target, NEVER_SYNC);
  } else {
    copyExtrasFiltered(localPath, target, NEVER_SYNC);
  }
  emitMirrorWet(opts.onPreview, name, localPath, target);
}

/**
 * Shared win32 host-to-repo mirror driving both `syncSharedLinksPush` and
 * `stageLocalSharedEdits`. The platform and null-map gates live here so both
 * callers can invoke their wrapper unconditionally with no branch of their own,
 * matching `applySharedLinks`'s win32-gating convention.
 *
 * @param map - Parsed `path-map.json`, or `null` to skip the pass entirely.
 * @param policy - Repo-side treatment; see {@link SharedMirrorPolicy}.
 * @param opts - `dryRun`/`onPreview`/`linkNames`; see {@link MirrorOpts}.
 */
function mirrorSharedNames(
  map: PathMap | null,
  policy: SharedMirrorPolicy,
  opts: MirrorOpts = {},
): void {
  if (process.platform !== 'win32') return;
  if (map === null) return;
  const claude = claudeHome();
  const repo = repoHome();
  const linkNames = opts.linkNames ?? allSharedLinks(map);
  for (const name of linkNames) {
    mirrorOneSharedName(name, claude, repo, policy, opts);
  }
}

/**
 * Win32 push-mirror for `allSharedLinks(map)` names: copies each real local
 * copy at `~/.claude/<name>` back into `shared/<name>` (repo side), so an
 * edit made through the win32 copy model (`applySharedLinksWin32` in
 * `links.ts`) reaches the repo at the next push. This is the write half of
 * the copy-sync model; `copySharedLinkPull` in `links.ts` is the read half.
 *
 * Mirrors `syncSkillsPush`'s pattern exactly: skip a name absent from
 * `~/.claude/` (nothing to mirror), skip a name that is still a live symlink
 * (a symlink-era leftover, or a host sharing `~/.claude` with a
 * symlink-capable OS; mirroring through it would rm the copy target from
 * under the `cpSync` source and crash), otherwise mirror via
 * `copyExtrasFiltered` with a blockSet seeded from `NEVER_SYNC`, so a
 * host-local sensitive name cannot ride from `~/.claude/` into the repo. See
 * `mirrorOneSharedName` for why that set and not the narrower subset
 * `copySharedLinkPull` still uses on the repo-to-host read half.
 *
 * On darwin/linux this is a no-op: the symlink means an edit at
 * `~/.claude/<name>` already lands in `shared/<name>` directly, so push has
 * nothing to mirror. The platform gate lives inside the function (an early
 * return) so callers can invoke it unconditionally with no branch of their
 * own, matching `applySharedLinks`'s win32-gating convention.
 *
 * `map` is nullable to match `loadSelectionForPush`'s return shape (a missing
 * `path-map.json` yields `map: null`); a null map skips the mirror entirely
 * rather than crashing on `allSharedLinks(null)`. The caller's own
 * `path-map.json missing` fatal fires later in the real-push pipeline.
 *
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally, so `cmdPush` can derive it once and thread
 * it through instead of every call site re-deriving it (which would
 * re-emit any `sharedDirs` rejection WARN once per call).
 *
 * @param map - Parsed `path-map.json`, or `null` when the file is absent.
 * @param opts - `linkNames`; see {@link MirrorOpts}. `dryRun`/`onPreview` are
 *   accepted for signature symmetry with `stageLocalSharedEdits` but are not
 *   exercised by the real-push-only call site today.
 */
export function syncSharedLinksPush(map: PathMap | null, opts: MirrorOpts = {}): void {
  mirrorSharedNames(map, { adoptNew: true, overlay: false }, opts);
}

/**
 * Pull-side counterpart of `syncSharedLinksPush`: make the host's own
 * `~/.claude/<name>` edits visible in the repo working tree BEFORE
 * `git pull --rebase --autostash` runs, so the autostash carries them through
 * the rebase exactly as a posix symlink already does. See
 * `reconcileSharedLinksBeforePull` in `commands.pull.win32.ts` for why the
 * pull needs this at all.
 *
 * Deliberately does NOT reuse the push policy. A push is an explicit publish
 * that the user asked for, and it is followed by the allow-list gate and the
 * gitleaks scan; a pull is neither, so it runs under the two conservative
 * settings instead:
 *
 * - `adoptNew: false`, so a name the repo does not already share is left alone.
 *   Creating `shared/<name>` from a purely host-local dir would turn a pull
 *   into a publish trigger (under `nomad sync` the push half would ship it to
 *   every other host), and it would invert the guarantee `applySharedLinks`
 *   enforces: a host with no `shared/<name>` counterpart keeps its private
 *   local copy.
 * - `overlay: true`, so a repo-side file the host copy happens to lack is not
 *   deleted. The goal here is only that a host EDIT is present for the rebase,
 *   not that the repo becomes a byte-exact mirror of the host; byte-exact
 *   mirroring belongs to the push, where the user asked for it.
 *
 * `backupTs` additionally snapshots each repo-side copy under
 * `backup/<ts>/repo/` first, so an uncommitted working-tree edit under
 * `shared/` stays recoverable (git cannot recover it: it was never committed).
 *
 * `opts.dryRun` (default `false`): when `true`, no disk mutation occurs at
 * all; a `MirrorPreviewEvent` is emitted per name instead (through
 * `opts.onPreview` when supplied, otherwise a `log()` fallback line).
 *
 * `opts.onPreview`: structured-event sink. On the dry-run path it receives
 * one event per name that would be mirrored. On the wet path it receives one
 * event per name actually mirrored, right after the copy lands; with no sink
 * supplied, the wet path stays silent (no log fallback), matching the
 * pre-existing contract every direct call to this function already relies on.
 *
 * `opts.linkNames`, when supplied, is used verbatim instead of deriving the
 * name list from `map` internally.
 *
 * @param map - Parsed `path-map.json`, or `null` when it could not be read.
 * @param ts - Backup timestamp, already resolved by `runPullCore`.
 * @param opts - `dryRun`/`onPreview`/`linkNames`; see {@link MirrorOpts}.
 */
export function stageLocalSharedEdits(
  map: PathMap | null,
  ts: string,
  opts: MirrorOpts = {},
): void {
  mirrorSharedNames(map, { adoptNew: false, overlay: true, backupTs: ts }, opts);
}

/**
 * Drop an untracked denylisted path out of the repo working tree, after
 * snapshotting it into this pull's own backup cache.
 *
 * Git never had the path, so git cannot recover it and the removal would
 * otherwise be permanent. That makes this the one destructive step in the
 * pre-pull reconcile with nothing behind it: its sibling `restoreTrackedDenied`
 * names a snapshot in its own WARN, and the deletion pass snapshots every file
 * it removes. A gate that fires on a false positive (an ordinary directory
 * spelled like a never-synced one) must not be the thing that loses the user's
 * work, so the snapshot lands first and the WARN names where it went.
 *
 * `backupRepoWrite` resolves under `~/.cache/claude-nomad/backup/<ts>/repo/`,
 * which is host-local and outside both the sync repo and `~/.claude/`. That
 * placement is load-bearing rather than incidental: the bytes being snapshotted
 * are denylisted by definition, so a copy anywhere the push stages from, scans,
 * or mirrors would hand the next publish exactly the content this call removed.
 *
 * `recursive` because `git status --untracked-files=all` does not descend into
 * a nested git repository: a wholly untracked directory containing a `.git`
 * arrives as one record, and a non-recursive removal cannot act on it at all.
 *
 * The success WARN is emitted only after `existsSync` confirms the path is
 * actually gone. `force` makes `rmSync` treat an absent path as success, so an
 * unconditional WARN would report a removal that never happened, which is the
 * worst possible reading of a security gate's own record of what it did: the
 * user is told a denylisted file left the working tree while it is still
 * sitting there one `git add` from the remote. Two ways to reach that: a path
 * whose bytes do not round-trip through the UTF-8 decode git's stdout goes
 * through, and a path removed between the snapshot and this call.
 *
 * Wrapped in its own try/catch so one unremovable path (an antivirus lock, a
 * read-only file, a path over the Windows limit) does not abandon the rest of
 * the sweep.
 *
 * @param repo - Absolute path to the sync repo.
 * @param path - Repo-relative path to remove.
 * @param segment - The path segment that matched the never-sync list.
 * @param ts - Backup timestamp, both the snapshot namespace and the location
 *   named in the WARN so the user can find the copy.
 */
function removeUntrackedDenied(repo: string, path: string, segment: string, ts: string): void {
  const abs = join(repo, path);
  try {
    backupRepoWrite(abs, ts, repo);
    rmSync(abs, { recursive: true, force: true });
    if (existsSync(abs)) {
      warn(
        `could not remove ${abs}: the path segment "${segment}" is on the never-sync list, so remove it by hand`,
      );
      return;
    }
    warn(
      `removed ${path} from the sync repo working tree: the path segment "${segment}" is on the never-sync list. A copy was snapshotted under backup/${ts}/repo/ first`,
    );
  } catch (err) {
    warn(`could not remove ${abs}: ${(err as Error).message}`);
  }
}

/**
 * Take a denylisted path with no committed content out of the index, leaving
 * the file itself alone.
 *
 * `git status` reports a staged-but-never-committed add (and the new-name half
 * of a rename) as tracked, but there is nothing in HEAD to restore it to, so
 * the restore below can only fail on it. That is also the state in which a user
 * is closest to publishing the content: the next `git commit` takes it. Dropping
 * it from the index is the narrowest action that changes that, and it destroys
 * nothing, because nothing committed is at risk.
 *
 * A rename is TWO index entries, and `source` is what makes this safe on one.
 * `git mv shared/commands/foo.md shared/commands/tasks/foo.md` stages an add of
 * the destination AND a deletion of the committed source; acting on the
 * destination alone leaves that deletion staged, so the next push publishes the
 * removal of a committed file and every other host loses it on its next pull.
 * That is strictly worse than the leak this gate exists to stop, and it is the
 * exact outcome {@link restoreTrackedDenied}'s contract rules out.
 *
 * `git reset HEAD -- <path>` rather than `git rm --cached`: reset restores the
 * destination's index entry to its HEAD state, which for a path absent from HEAD
 * drops the entry (identical to `rm --cached` on a plain staged add) without
 * touching the SOURCE's own entry. `git checkout HEAD -- <source>` then puts the
 * source back in both the index and the working tree, which is what clears the
 * staged deletion. Neither step can resurrect denylisted content: `path` is
 * absent from HEAD by construction, so there is nothing there to check out.
 *
 * The destination file is deliberately left on disk. The gate's business is what
 * the repo is about to publish, not what the user keeps in their own working
 * tree, and a hand-placed file under `shared/` may well be wanted there; the WARN
 * says so explicitly so the user is never left believing it was deleted.
 *
 * @param repo - Absolute path to the sync repo.
 * @param path - Repo-relative path to unstage.
 * @param segment - The path segment that matched the never-sync list.
 * @param source - When `path` is the destination half of a staged rename or
 *   copy, the repo-relative source path whose index entry has to be restored
 *   alongside. Absent for a plain staged add.
 */
function unstageDeniedAdd(repo: string, path: string, segment: string, source?: string): void {
  if (gitTryMutate(['reset', '-q', 'HEAD', '--', path], repo) === null) {
    warn(
      `could not unstage ${path}: the path segment "${segment}" is on the never-sync list, so unstage it by hand before committing`,
    );
    return;
  }
  if (source !== undefined && gitTryMutate(['checkout', 'HEAD', '--', source], repo) === null) {
    warn(
      `unstaged ${path}, but could not restore ${source}, which the same rename staged for deletion: run "git checkout HEAD -- ${source}" by hand, or the next push publishes that deletion`,
    );
    return;
  }
  const undone =
    source === undefined ? '' : ` The rename it was half of is undone, so ${source} is back.`;
  warn(
    `unstaged ${path}: the path segment "${segment}" is on the never-sync list.${undone} The file is still on disk, so remove it by hand if you did not mean to add it`,
  );
}

/**
 * Restore a tracked denylisted path to its committed content.
 *
 * Restored rather than deleted on purpose: deleting a tracked path would turn a
 * content gate into a deletion of committed repo content, which is a strictly
 * worse outcome than the leak it is trying to prevent.
 *
 * A path git reports as tracked but that is no longer in the working tree is
 * already gone (the deletion pass removed it, or the user did). Checking it out
 * of HEAD would put denylisted content BACK, which is the opposite of what this
 * gate is for, so that case is left alone.
 *
 * "Tracked" is decided by presence in HEAD, not by the `git status` prefix that
 * routed the path here: that prefix also covers a staged add and a rename
 * target, neither of which has committed content to protect. Those go to
 * `unstageDeniedAdd` instead, since the reasoning above does not apply to them.
 *
 * That question is asked with a TREE lookup (`git ls-tree HEAD -- <path>`) and
 * answered only on a POSITIVE result, because the destructive branch is the one
 * a wrong answer selects. `gitProbe` collapses every failure to `null`: git
 * absent, the probe timeout expiring, an unborn or corrupt HEAD, an unreadable
 * repo, a promisor clone that cannot materialize an object. Exactly one of those
 * means "nothing committed is at risk", so a `null` must leave the path alone
 * and say so rather than unstage on a guess.
 *
 * A tree lookup rather than a blob probe for the same reason. `cat-file -e
 * HEAD:<path>` has to materialize the object, so it fails on a committed GITLINK
 * (whose commit lives in the submodule's object store) and on a partial clone
 * that has not fetched the blob, reporting a committed entry as absent from HEAD.
 * `ls-tree` reads the tree entry itself: empty stdout means the path really is
 * not in HEAD, and non-empty means it is, gitlink included. Gitlinks under
 * `shared/` are a state this repo already handles elsewhere (`guardGitlinks` on
 * the push path), so this is a reachable case, not a hypothetical one.
 *
 * The restore runs through `gitTryMutate` (and the HEAD lookup through its
 * read-only sibling `gitProbe`) rather than `gitOrFatal` because nothing in the
 * pre-rebase path may fail a pull; a call that cannot answer leaves the file as
 * it found it and says so, so the user knows to remove it by hand. No try/catch:
 * both are the same never-throwing invoker, so a catch here would be
 * unreachable.
 *
 * @param repo - Absolute path to the sync repo.
 * @param path - Repo-relative path to restore.
 * @param segment - The path segment that matched the never-sync list.
 * @param ts - Backup timestamp, named in the WARN so the user can find the
 *   pre-pull snapshot of any uncommitted edit this restore discards.
 * @param source - The rename source when `path` is a rename destination; see
 *   {@link unstageDeniedAdd}.
 */
function restoreTrackedDenied(
  repo: string,
  path: string,
  segment: string,
  ts: string,
  source?: string,
): void {
  if (!existsSync(join(repo, path))) return;
  const inHead = gitProbe(['ls-tree', '--name-only', 'HEAD', '--', path], repo);
  if (inHead === null) {
    warn(
      `could not check ${path} against HEAD: the path segment "${segment}" is on the never-sync list, so handle it by hand before committing`,
    );
    return;
  }
  if (inHead.trim() === '') {
    unstageDeniedAdd(repo, path, segment, source);
    return;
  }
  if (gitTryMutate(['checkout', 'HEAD', '--', path], repo) === null) {
    warn(
      `could not restore ${path} to its committed content: the path segment "${segment}" is on the never-sync list, so remove it by hand before committing`,
    );
    return;
  }
  warn(
    `restored ${path} to its committed content: the path segment "${segment}" is on the never-sync list. Any uncommitted edit to it was snapshotted under backup/${ts}/repo/ before the pull`,
  );
}

/**
 * Revert every denylisted path out of the repo working tree, after both
 * pre-pull passes have run.
 *
 * The second of the two layers guarding the host-to-repo boundary.
 * `mirrorOneSharedName`'s copy-time filter means the mirror never writes such a
 * path in the first place; this catches the ones that reach `shared/` another
 * way. Two of those are real: a hand-edit made directly under the repo, which
 * no copy filter sees, and content appended to an ALREADY-TRACKED file, which
 * the mirror's own untracked-file accounting is blind to by construction.
 *
 * Never throws and never fails the pull. A hit is a WARN plus a revert; the
 * caller carries on into `git pull --rebase` either way. The push side's
 * `enforceAllowList` throws instead, which is right for an explicit publish the
 * user can retry and wrong for a step that runs on every shell start on some
 * hosts.
 *
 * The whole `parsePorcelainZ` result is taken rather than its two path arrays,
 * because the rename pairing it also reports is load-bearing here: a denylisted
 * rename DESTINATION cannot be undone correctly without knowing which source the
 * same index operation staged for deletion. See {@link unstageDeniedAdd}.
 *
 * @param repo - Absolute path to the sync repo.
 * @param status - The `git status` snapshot, as `parsePorcelainZ` returns it.
 * @param ts - Backup timestamp, resolved once by the caller.
 */
export function revertDeniedMirrorPaths(
  repo: string,
  status: DeniedRevertStatus,
  ts: string,
): void {
  for (const path of status.untracked) {
    const segment = deniedSegmentFor(path);
    if (segment !== null) removeUntrackedDenied(repo, path, segment, ts);
  }
  for (const path of status.tracked) {
    const segment = deniedSegmentFor(path);
    if (segment !== null) {
      restoreTrackedDenied(repo, path, segment, ts, status.renameSources?.[path]);
    }
  }
}
