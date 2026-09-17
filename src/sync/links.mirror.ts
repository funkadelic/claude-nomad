/**
 * The win32-only host-to-repo mirror, extracted from `links.ts` so the
 * host->repo write half lives beside itself and `links.ts` no longer carries
 * the whole thing.
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  allSharedLinks,
  claudeHome,
  repoHome,
  ALWAYS_NEVER_SYNC,
  type PathMap,
} from '../core/config.ts';
import { errorText } from '../core/error-text.ts';
import { copyExtrasFiltered, copyExtrasOverlayFiltered } from './extras/core.ts';
import { classifyPresence, isUnusableTarget, type PresenceState } from '../core/fs-presence.ts';
import { log, warn } from '../core/utils.ts';
import { backupRepoWrite } from '../core/utils.fs.ts';

export { revertDeniedMirrorPaths } from './links.mirror.revert.ts';

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
 * `log()` fallback: a wet run with no sink attached stays byte-silent on the
 * SUCCESS path, so `syncSharedLinksPush(map)`'s existing call site and every
 * direct-call test are unaffected by this event's introduction. The silence is
 * success-only: an unreadable name still WARNs from `mirrorOneSharedName`,
 * sink or no sink, since a skipped capture has to reach the operator somehow.
 */
function emitMirrorWet(
  onPreview: MirrorOpts['onPreview'],
  name: string,
  localPath: string,
  repoPath: string,
): void {
  if (onPreview) onPreview({ kind: 'mirror', name, localPath, repoPath });
}

/** How one mirror pass treats the repo side. See the two exported wrappers. */
type SharedMirrorPolicy = {
  /** Overlay onto the repo copy instead of replacing it wholesale. */
  overlay: boolean;
  /** When set, snapshot the repo copy under `backup/<ts>/repo/` before writing. */
  backupTs?: string;
};

/**
 * True when `target` (`shared/<name>`) does not yet exist, so this mirror
 * pass should leave the name alone rather than create it.
 *
 * Both the push and the pull mirror run under this same policy: publishing a
 * directory to every other host is a deliberate act, performed by
 * `nomad adopt <name>`, never an implicit side effect of a pull or a push.
 *
 * @param target - Absolute `shared/<name>` path for the name under test.
 * @returns `true` when the name should be skipped as not shared.
 */
function notShared(target: string): boolean {
  return !existsSync(target);
}

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
 * The copy filter runs against `ALWAYS_NEVER_SYNC`, the credential and
 * host-config floor, rather than the full `NEVER_SYNC` set. Every path this
 * mirror writes lives under `shared/<name>` and never under `shared/extras/`,
 * so `blockSetFor` resolves such a path to `ALWAYS_NEVER_SYNC` too: this
 * computes, at copy time and with no git invocation, exactly the answer the
 * repo-working-tree backstop computes for the same path afterwards. The point
 * is that the two layers agree, and the backstop stays a genuine second layer
 * rather than the only line of defense.
 *
 * An ordinary directory inside a shared name is carried rather than silently
 * dropped: the full `NEVER_SYNC` set was authored against `~/.claude/`'s own
 * directory semantics and carries several ordinary-sounding runtime-state
 * names that a user's own `sharedDirs` content can legitimately contain, and
 * that content is now published intact. Only the five credential and
 * host-config names in `ALWAYS_NEVER_SYNC` are still filtered out here.
 * `isDeniedName` matches whole segments, not substrings, so a FILE named
 * `tasks.md` was never affected either way; only a path segment spelled
 * exactly `tasks` ever collided.
 *
 * The stat is wrapped in its own try/catch because `throwIfNoEntry: false`
 * suppresses ENOENT only; EACCES, EPERM and EIO still throw. Since the preview
 * path (`computePreview` in `preview.ts`) now calls this mirror directly, with
 * no enclosing try/catch of its own, an unreadable local path must degrade to
 * one skipped name rather than crash `nomad diff`/`pull --dry-run`, whose
 * whole value is being safe to run. On the wet path this also narrows the
 * blast radius of a locked file from aborting the entire mirror pass (the
 * outer catch in `reconcileSharedLinksBeforePull`) to skipping just this name.
 * The skip WARNs rather than returning silently: the direction is safe, nothing
 * is written, but a wet pull that fails to capture a local shared-config edit
 * and says nothing about it is exactly the silence this mirror was made visible
 * to remove. Only a real error reaches the warning, since `throwIfNoEntry`
 * already absorbs the ordinary absent-path case, and only a name this pass
 * would actually have captured: an unreadable name the repo does not share was
 * never going to be copied, since both wrappers now decline to adopt a new
 * name, so reporting it would read as data loss on a directory that is
 * deliberately host-private. The wording
 * claims nothing about the rest of the command, only about this mirror pass.
 *
 * The warning has two arms, branched on `opts.dryRun`. Three of this
 * function's four callers never write to the repo at all: `nomad diff` and
 * `pull --dry-run` (via `preview.ts`'s call into this mirror), the pre-pull
 * reconcile planner, and the wedge-recovery discard tally, all of which pass
 * `dryRun: true`. Telling any of them that a name "was left out of shared/
 * this run" claims an omitted write for work that was never scheduled, which
 * is a false statement about what actually happened.
 *
 * The read-only arm's wording is scoped to that claim and nothing wider,
 * because `dryRun` means "this call writes nothing", not "the user is looking
 * at a preview". `describeSkippedMirrorDiscard` (`commands/pull/win32.ts`)
 * passes `dryRun: true` from inside a REAL `nomad pull` on the force-remote
 * recovery path, so an arm framed around previewing would tell a user
 * mid-pull that they are previewing. The one wet caller,
 * `reconcileSharedLinksBeforePull` (no `dryRun` key), keeps the original
 * wording unchanged: its claim about a skipped write is accurate there.
 *
 * A third outcome sits above the `notShared` check: `shared/<name>` can also
 * be a symlink that does not resolve, distinct from both "not shared" (never
 * published, silent, unchanged) and "shared" (mirrors normally, unchanged).
 * The mirror still writes nothing for that case, `copyExtrasFiltered`'s
 * behavior against a dangling destination is unproven, and probing the
 * target and then writing through it anyway would open a TOCTOU window this
 * phase deliberately does not open, but it always WARNs first, via
 * {@link warnUnusableSharedTarget}, naming the name and the broken repo
 * pointer. The existing WARN-on-unreadable-local-name arm just above this
 * one is the direct precedent for both the wording shape and the "this WARN
 * always fires, sink or no sink" rule.
 *
 * The compound state, a name whose LOCAL path is unreadable AND whose
 * `shared/<name>` is ALSO unusable, reports the repo side. Both facts are
 * true, but only one of them tells the user something they can act on from
 * this host: the local path may become readable again on its own (a program
 * closes the file), while an unusable repo entry stays unusable until someone
 * fixes it in the sync repo, and it is the half that keeps this name from
 * syncing even after the local side clears.
 *
 * @param name - Shared name from `allSharedLinks`.
 * @param claude - `claudeHome()`, resolved once by the caller.
 * @param repo - `repoHome()`, resolved once by the caller.
 * @param policy - Repo-side treatment; see {@link SharedMirrorPolicy}.
 * @param opts - `dryRun`/`onPreview`; see {@link MirrorOpts}.
 */
/**
 * WARN that `shared/<name>` does not resolve to anything usable, so this
 * mirror pass left it alone. Extracted out of {@link mirrorOneSharedName} so
 * the message composition does not add to that function's own branch count
 * against the cognitive-complexity gate, matching the extraction rationale
 * already documented on that function.
 *
 * Neither arm ever says "symlink": a genuine stat error is not a symlink at
 * all, and naming one specifically would misdescribe that case.
 *
 * The reason and remedy vary with `state` rather than being fixed text,
 * because `isUnusableTarget` groups `dangling` and `unknown` for control flow
 * only. Telling a user whose `shared/<name>` merely could not
 * be read that it "does not resolve", and to restore what it points at, states
 * a read that never happened and prescribes a repair for a break that may not
 * exist. Doctor's `repoSourceUnusableRow` and adopt's `alreadySymlinkMessage`
 * split the same way, which is what keeps the three surfaces telling one story
 * about one on-disk state.
 *
 * @param name - Shared name from `allSharedLinks`.
 * @param dryRun - `true` when the calling pass writes nothing regardless, so
 *   the wording claims no write was skipped rather than one that already
 *   would not have happened.
 * @param state - The unusable state observed at `shared/<name>`.
 */
function warnUnusableSharedTarget(name: string, dryRun: boolean, state: PresenceState): void {
  // Neither arm ends in terminal punctuation, so the wet path below can append
  // its own trailing clause to either one.
  const reason =
    state === 'dangling'
      ? `shared/${name} does not resolve to anything usable in the sync repo. Remove it, or restore what it points at`
      : `shared/${name} could not be read in the sync repo, so whether it is usable could not be determined. Check its permissions there`;
  if (dryRun) {
    warn(`${name} would not be captured into shared/: ${reason}`);
    return;
  }
  warn(`${name} was not captured into shared/ this run: ${reason}, then run \`nomad push\` again`);
}

/**
 * WARN that `~/.claude/<name>` could not be read, so this mirror pass could
 * promise nothing about it, instead of dropping the name without a word.
 * Extracted out of {@link mirrorOneSharedName} for the same reason
 * {@link warnUnusableSharedTarget} was: the branch set here would otherwise
 * push that function past the cognitive-complexity gate.
 *
 * Silent for a name this pass would have skipped anyway, so an ACL change on
 * `~/.claude/` reports the one name it actually cost rather than one line per
 * shared name.
 *
 * The repo side is classified BEFORE that not-shared guard, because
 * `notShared` is an `existsSync` probe that follows the link, so it reads an
 * unusable `shared/<name>` as "never published" and returns silently. The
 * compound state (local unreadable AND repo entry unusable) is the one where
 * both halves are broken, which makes it the last one that should be quiet,
 * and the repo half is what keeps the name from syncing even after the local
 * side clears.
 *
 * @param name - Shared name from `allSharedLinks`.
 * @param target - Absolute `shared/<name>` path in the repo.
 * @param err - The error `lstatSync` threw for the local path.
 * @param dryRun - `true` when the calling pass writes nothing regardless.
 */
function warnUnreadableLocalName(
  name: string,
  target: string,
  err: unknown,
  dryRun: boolean,
): void {
  const compoundState = classifyPresence(target);
  if (isUnusableTarget(compoundState)) {
    warnUnusableSharedTarget(name, dryRun, compoundState);
    return;
  }
  if (notShared(target)) return;
  if (dryRun) {
    warn(
      `${name} could not be read (${errorText(err)}), so nothing was captured for it and nothing was written. A pull that captures shared edits would skip it too. Check its permissions, or whether another program has it open`,
    );
    return;
  }
  warn(
    `${name} could not be read (${errorText(err)}), so it was left out of shared/ this run. Check its permissions, or whether another program has it open`,
  );
}

function mirrorOneSharedName(
  name: string,
  claude: string,
  repo: string,
  policy: SharedMirrorPolicy,
  opts: MirrorOpts,
): void {
  const localPath = join(claude, name);
  const target = join(repo, 'shared', name);
  let stat;
  try {
    stat = lstatSync(localPath, { throwIfNoEntry: false });
  } catch (err) {
    warnUnreadableLocalName(name, target, err, opts.dryRun === true);
    return;
  }
  if (stat === undefined) return; // absent: nothing to mirror
  if (stat.isSymbolicLink()) return; // symlink-era live link; defer to next pull
  const targetState = classifyPresence(target);
  if (isUnusableTarget(targetState)) {
    warnUnusableSharedTarget(name, opts.dryRun === true, targetState);
    return;
  }
  if (notShared(target)) return; // repo does not share this name

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
    copyExtrasOverlayFiltered(localPath, target, ALWAYS_NEVER_SYNC);
  } else {
    copyExtrasFiltered(localPath, target, ALWAYS_NEVER_SYNC);
  }
  emitMirrorWet(opts.onPreview, name, localPath, target);
}

/**
 * WARN once that the `shared/` directory itself is unusable, so this mirror
 * pass left EVERY configured name alone.
 *
 * Separate wording from {@link warnUnusableSharedTarget} on purpose. That one
 * names a single shared name, and when the parent is what broke it fired once
 * per configured name, so a reader saw a column of individually-accurate lines
 * and still could not tell one broken name from a broken directory. This arm
 * names `shared/` itself and says the whole pass was skipped, which is the
 * fact the per-name wording could not express.
 *
 * Splits `dangling` from `unknown` for the same reason the per-name warning
 * does: a directory that merely could not be READ has not been shown to be
 * broken, so prescribing "restore what it points at" would name a repair for a
 * break that may not exist.
 *
 * @param dryRun - `true` when the calling pass writes nothing regardless, so
 *   the wording claims no write was skipped rather than one that already would
 *   not have happened.
 * @param state - The unusable state observed at `shared/`.
 */
function warnUnusableSharedDir(dryRun: boolean, state: PresenceState): void {
  // Neither arm ends in terminal punctuation, so the wet path below can append
  // its own trailing clause to either one.
  const reason =
    state === 'dangling'
      ? 'shared/ does not resolve to anything usable in the sync repo. Remove it, or restore what it points at'
      : 'shared/ could not be read in the sync repo, so whether it is usable could not be determined. Check its permissions there';
  if (dryRun) {
    warn(`no shared name would be captured into shared/: ${reason}`);
    return;
  }
  warn(
    `no shared name was captured into shared/ this run: ${reason}, then run \`nomad push\` again`,
  );
}

/**
 * Whether `p` resolves to a directory, answered without throwing.
 *
 * Only ever called for a path {@link classifyPresence} already reported as
 * `resolves`, so the `statSync` is expected to succeed; the guard is for the
 * window between the two probes, and treats a path it can no longer read as
 * "not a directory" so the caller reports rather than proceeding into a loop
 * that cannot work.
 *
 * @param p - Absolute path, already known to resolve.
 * @returns `true` only when `p` is a directory.
 */
function resolvesToDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * WARN once that `shared/` is not a directory at all, so this mirror pass had
 * nowhere to write and left every configured name alone.
 *
 * Distinct from {@link warnUnusableSharedDir}: that one answers a pointer that
 * is broken or unreadable, while this answers a `shared/` that resolves
 * perfectly well and is simply the wrong KIND of thing, usually a regular file
 * or a symlink to one. The remedy differs too, so the wording does.
 *
 * This state was previously silent in both directions, and worse than the
 * repeated warning that motivated the parent probe: every per-name probe under
 * a non-directory parent raises `ENOTDIR`, which the presence leaf reports as
 * `absent`, so `notShared` skipped each name without a word and a whole push
 * mirrored nothing while saying nothing.
 *
 * @param dryRun - `true` when the calling pass writes nothing regardless.
 */
function warnSharedNotADirectory(dryRun: boolean): void {
  // Neither arm ends in terminal punctuation, so the wet path below can append
  // its own trailing clause to either one.
  const reason =
    'shared/ in the sync repo is not a directory, so there is nowhere to capture names into. Replace it with the shared/ directory the repo expects';
  if (dryRun) {
    warn(`no shared name would be captured into shared/: ${reason}`);
    return;
  }
  warn(
    `no shared name was captured into shared/ this run: ${reason}, then run \`nomad push\` again`,
  );
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
  // Probe the shared/ PARENT once before the loop. When it is unusable every
  // per-name probe below fails closed to `unknown`, so without this the pass
  // emitted one warning per configured name for a single broken directory.
  // Only `dangling`/`unknown` short-circuit: `absent` is NOT unusable, and a
  // repo with no shared/ directory must keep falling through to the per-name
  // `notShared` skip, which is deliberately silent.
  const sharedPath = join(repo, 'shared');
  const sharedState = classifyPresence(sharedPath);
  if (isUnusableTarget(sharedState)) {
    warnUnusableSharedDir(opts.dryRun === true, sharedState);
    return;
  }
  // A `shared/` that resolves can still be the wrong KIND of entry. A regular
  // file there raises ENOTDIR on every per-name probe, which the presence leaf
  // reports as `absent`, so each name used to be skipped in total silence.
  // `absent` itself is left alone: a repo with no shared/ yet simply shares
  // nothing, which is not a fault to report.
  if (sharedState === 'resolves' && !resolvesToDirectory(sharedPath)) {
    warnSharedNotADirectory(opts.dryRun === true);
    return;
  }
  const linkNames = opts.linkNames ?? allSharedLinks(map);
  for (const name of linkNames) {
    mirrorOneSharedName(name, claude, repo, policy, opts);
  }
}

/**
 * Win32 push-mirror for `allSharedLinks(map)` names: copies each real local
 * copy at `~/.claude/<name>` back into an EXISTING `shared/<name>` (repo
 * side), so an edit made through the win32 copy model
 * (`applySharedLinksWin32` in `links.win32.ts`) reaches the repo at the next push.
 * This is the write half of the copy-sync model; `copySharedLinkPull` in
 * `links.ts` is the read half.
 *
 * Declines to create `shared/<name>` for a name the repo does not already
 * carry. Publishing a directory to every
 * other host is a deliberate act, and the command that performs it is
 * `nomad adopt <name>`, not an implicit side effect of the next push. This
 * matches the behavior macOS, Linux and WSL2 have always had, where a name
 * with no repo counterpart simply stays a private local directory; matching
 * it on native Windows removes a platform-specific way to publish something
 * without asking.
 *
 * A name whose `shared/<name>` already exists is unaffected by that policy
 * and is re-mirrored on every push exactly as before, so nothing already
 * published stops publishing and no host needs a migration step.
 *
 * Mirrors `syncSkillsPush`'s pattern otherwise: skip a name absent from
 * `~/.claude/` (nothing to mirror), skip a name that is still a live symlink
 * (a symlink-era leftover, or a host sharing `~/.claude` with a
 * symlink-capable OS; mirroring through it would rm the copy target from
 * under the `cpSync` source and crash), otherwise mirror via
 * `copyExtrasFiltered` with a blockSet seeded from `ALWAYS_NEVER_SYNC`, so a
 * host-local sensitive name cannot ride from `~/.claude/` into the repo. This
 * write half and `copySharedLinkPull`'s repo-to-host read half now apply the
 * identical set, so what a push carries into the repo is exactly what a pull
 * carries back onto a host, with nothing stripped in one direction that
 * survived in the other. Both wrappers now decline to adopt a new name, so
 * the only remaining difference between this push policy and
 * `stageLocalSharedEdits`'s pre-pull policy is `overlay` and the backup
 * snapshot.
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
  mirrorSharedNames(map, { overlay: false }, opts);
}

/**
 * Pull-side counterpart of `syncSharedLinksPush`: make the host's own
 * `~/.claude/<name>` edits visible in the repo working tree BEFORE
 * `git pull --rebase --autostash` runs, so the autostash carries them through
 * the rebase exactly as a posix symlink already does. See
 * `reconcileSharedLinksBeforePull` in `commands/pull/win32.ts` for why the
 * pull needs this at all.
 *
 * Deliberately does NOT reuse the push policy. A push is an explicit publish
 * that the user asked for, and it is followed by the allow-list gate and the
 * gitleaks scan; a pull is neither, so it runs under the two conservative
 * settings instead:
 *
 * - Leaves a name the repo does not already share alone. Creating
 *   `shared/<name>` from a purely host-local dir would turn a pull into a
 *   publish trigger (under `nomad sync` the push half would ship it to every
 *   other host), and it would invert the guarantee `applySharedLinks`
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
  mirrorSharedNames(map, { overlay: true, backupTs: ts }, opts);
}
