/**
 * What each step of the adopt move does when it fails.
 *
 * `commands.adopt.ts` owns the command: validation, the precondition matrix,
 * and the backup -> copy -> remove -> restore -> stage sequence. Every guard
 * that sequence reaches for when a step goes wrong lives here, so the failure
 * semantics (what is left on disk, which platform calls that healthy, what the
 * user is told to run) can be read as one piece. Mirrors the naming convention
 * `commands.push.recovery*.ts` already sets.
 */

import { lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { deniedEntriesRefusal, scanOrFatal } from './commands.adopt.scan.ts';
import { claudeHome, NEVER_SYNC } from './config.ts';
import { EXIT } from './exit-codes.ts';
import { copyExtrasFiltered } from './extras-sync.core.ts';
import { copySharedLinkPull } from './links.ts';
import { warn, NomadFatal } from './utils.ts';

/**
 * The text to quote for a caught value, whatever was actually thrown.
 *
 * Every message this module builds ends with the cause in parentheses, and
 * reading `.message` off an unknown directly renders the literal `undefined`
 * for anything that is not an `Error`, which is the one place a failure report
 * cannot afford to go vague. The calls these catches span (`copyExtrasFiltered`,
 * `copySharedLinkPull`, `rmSync`, a staging closure) raise real `Error`s
 * today, so this is about what a future caller or an injected fault produces,
 * not a bug on any path in the current tree.
 *
 * Structural rather than `instanceof`, matching `isUserAbort` in
 * `user-abort.ts`: an `Error` crossing a realm boundary fails the prototype
 * check, and a thrown plain object carrying a `message` still says something
 * more useful than `[object Object]`.
 *
 * @param err The caught value.
 * @returns Its `message` when it has a string one, otherwise its `String` form.
 */
function errorText(err: unknown): string {
  const message = (err as Error | undefined)?.message;
  return typeof message === 'string' ? message : String(err);
}

/**
 * lstat-based existence check that, unlike `existsSync`, does NOT follow
 * symlinks: a dangling symlink at `p` returns true. Used for the clobber
 * guard so an existing (even broken) `shared/<name>` link is refused rather
 * than fed to `cpSync`, which would otherwise throw an opaque non-NomadFatal
 * error on a dangling-symlink destination.
 *
 * @param p Absolute path to probe.
 * @returns True when any entry (file, dir, or symlink) exists at `p`.
 */
export function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `abs` is a direct child of `root`, both resolved first.
 *
 * The containment bound for a recursive force-remove. Exported only so it can
 * be asserted directly: the guard it backs is unreachable through `cmdAdopt`
 * (the name is rejected long before a path is built from it), so a test that
 * went through the command could not tell a working bound from an inverted
 * one. Direct-child rather than prefix containment because the only paths this
 * ever sees are `join(CLAUDE_HOME, <single name>)`, and prefix containment
 * would also accept a nested path several levels down.
 *
 * @param root Directory the path must sit directly inside.
 * @param abs Path to test.
 * @returns True when `abs` is exactly one level under `root`.
 */
export function isDirectChildOf(root: string, abs: string): boolean {
  return dirname(resolve(abs)) === resolve(root);
}

/**
 * Clear the partial `~/.claude/<name>` a failed copy-back can leave behind.
 *
 * Not tidiness: the win32 push mirror (`syncSharedLinksPush` -> `copyExtrasFiltered`)
 * WIPES `shared/<name>` and rebuilds it from whatever is at the host path, so a
 * truncated remnant left here would replace the fully adopted content in the repo
 * on the next push and propagate that loss to every other host. An absent host
 * entry makes the mirror skip the name entirely, which is the safe state. The
 * remnant is always a strict subset of `shared/<name>` (the copy into the repo
 * completed before the source was removed), so nothing unique is discarded.
 *
 * Best-effort by necessity: whatever blocked the copy usually blocks this too.
 * The caller reports the outcome rather than assuming it, and a "not cleared"
 * answer (whether the removal was refused, threw, or silently left the entry
 * behind) is what makes it warn against pushing.
 *
 * The bound is re-read from `claudeHome()` rather than taken from the caller,
 * so the check compares against the configured root instead of against the
 * same value the path was built from, which would make it vacuous. Bounding,
 * removing and re-probing are {@link clearIfDirectChild}'s job.
 *
 * @param linkPath Host-side path to clear.
 * @returns True when the path is gone afterwards.
 */
function clearPartialCopy(linkPath: string): boolean {
  return clearIfDirectChild(claudeHome(), linkPath);
}

/**
 * Clear the partial `shared/<name>` a failed copy-into-the-repo leaves behind.
 *
 * The repo-side counterpart of {@link clearPartialCopy}, and the reason it is
 * worth doing rather than reporting: `adoptStopsEarly` (in `commands.adopt.ts`)
 * turns any run whose
 * `shared/<name>` already exists away (a `would clobber` refusal on posix, a
 * false already-adopted report on win32), so a remnant left here turns a plain
 * re-run of the command that just failed into a manual `rm` the user was never
 * told about.
 *
 * That refusal is a worktree probe (`lexists`), so it says nothing about the
 * index: `shared/<name>` can be tracked in HEAD while absent from the worktree,
 * which is exactly the state a user reaches by doing what the refusal asks. The
 * removal here does not create that deletion, it restores the state the user
 * had already made, but it does not repair it either, and `push` stages with
 * `git add -A`, so a deletion left standing is committed by the next push.
 * `git checkout -- shared/<name>` in the repo is the way back.
 *
 * Best-effort and re-probed, for the same reasons spelled out on
 * {@link clearPartialCopy}; the caller reports the outcome rather than
 * assuming it.
 *
 * @param sharedTarget Repo-side path to clear.
 * @param repo Absolute path to the nomad repo root, the containment bound's parent.
 * @returns True when the path is gone afterwards.
 */
function clearPartialShared(sharedTarget: string, repo: string): boolean {
  return clearIfDirectChild(join(repo, 'shared'), sharedTarget);
}

/**
 * Best-effort recursive remove of `target`, bounded to a direct child of
 * `root` and answered by a re-probe rather than by the absence of a throw.
 *
 * Shared core behind the two clears above, which differ only by their
 * containment bound. Keeping one body means the bound, the broad catch, and
 * the re-probe cannot drift apart between the host side and the repo side.
 *
 * A recursive force-remove earns a containment check at the point of use, not
 * only at the entry point. `cmdAdopt` already rejects any name carrying a path
 * separator or a `.`/`..` segment before it builds either path, so this cannot
 * fire today; it is here so the removal stays bounded to one direct child of
 * its root if a future caller reaches it by another route, and so the bound is
 * checkable where the destructive call is rather than three guards away.
 *
 * The result is a re-probe, not the absence of a throw. On win32 a delete can
 * be accepted and still leave the entry in place until the last handle closes,
 * which is precisely the case this runs in (the copy just failed because
 * something holds the path), so a caller told "removed" would go on to describe
 * a path that is still there. Same discipline as `removeUntrackedDenied` in
 * `links.mirror.ts`, which re-probes the identical call for the identical
 * reason.
 *
 * @param root Directory `target` must sit directly inside.
 * @param target Path to remove.
 * @returns True when nothing is at `target` afterwards.
 */
function clearIfDirectChild(root: string, target: string): boolean {
  const resolved = resolve(target);
  /* c8 ignore next -- unreachable via cmdAdopt; the predicate is tested directly */
  if (!isDirectChildOf(root, resolved)) return false;
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch {
    return false;
  }
  // lstat-based, so a dangling symlink still counts as present: the question
  // is whether an entry is there for the mirror to read, not whether it
  // resolves.
  return !lexists(resolved);
}

/**
 * Stage `shared/<name>`, reporting a staging failure as a clause instead of
 * letting it throw.
 *
 * `gitOrFatal` raises its own `NomadFatal`, which would propagate out of the
 * copy-back catch and replace the whole report with a bare `git add ... failed`,
 * so the user would never learn the local copy is missing. The failure still has
 * to be told (an unstaged `shared/<name>` needs its own `git add` before a push
 * publishes anything), just not at the cost of the message it interrupted.
 *
 * @param stage Stages `shared/<name>`.
 * @returns An empty string on success, or a clause naming the staging failure.
 */
function stageOrReport(stage: () => void): string {
  try {
    stage();
    return '';
  } catch (err) {
    return ` Staging it failed too (${errorText(err)}), so it is in the repo but not staged.`;
  }
}

/**
 * Say what is at `linkPath` after a failed win32 copy-back, clearing it first
 * when clearing it is the right thing to do.
 *
 * Three states, and the push advice differs in each:
 *
 * - The source was never removed, so the path holds the complete original.
 *   Nothing is cleared (see {@link restoreWin32LocalCopy} for why that would be
 *   destructive), and a push is not only safe but wanted: the mirror publishes
 *   that original over `shared/<name>`, which is the same content the copy
 *   already put there.
 * - The source was removed and the remnant was cleared, so nothing is at the
 *   path and there is nothing to say.
 * - The source was removed and the remnant could not be cleared, so a push
 *   would mirror a truncated copy over the fully adopted `shared/<name>` and
 *   propagate that loss to every other host. That is the one case that earns a
 *   do-not-push warning.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side path to describe.
 * @param sourceRemoved False when the move's own removal of `linkPath` failed.
 * @returns A clause to append to the failure message, or an empty string.
 */
function describeLeftoverAt(name: string, linkPath: string, sourceRemoved: boolean): string {
  if (!sourceRemoved) {
    return (
      ` The original is still at ${linkPath}, because removing it failed too (warned above), ` +
      `so this host keeps a complete local copy and a later \`nomad push\` publishes it.`
    );
  }
  if (clearPartialCopy(linkPath)) return '';
  return (
    ` A partial copy may still be at that path, so do NOT run \`nomad push\` or \`nomad sync\` ` +
    `yet: either one copies that path back over shared/${name}, and \`nomad sync\` pushes in the ` +
    `same run. Pull first, and check it does not warn about ${name} again, because a pull that ` +
    `cannot read the path warns and still exits 0.`
  );
}

/**
 * Restore the host-side copy after a win32 move, failing loud rather than
 * crashing when the destination cannot be written.
 *
 * By the time this runs the copy into `shared/<name>` has already succeeded, so
 * a failure here costs the local copy, never the content, and the honest report
 * is a `NomadFatal` naming the path rather than either a crash report or a
 * success message. `nomad adopt` takes exactly one name per invocation, so
 * there is no rest-of-the-list to preserve by warning and continuing the way
 * the pull's apply loop does (`applyOneSharedLinkWin32` in `links.ts`).
 *
 * The source is normally gone by now, which is what makes anything left at
 * `linkPath` a truncated remnant worth clearing. `sourceRemoved` is false on
 * the one arm where that is not true: `reportSourceRemovalFailure` warned that
 * the removal failed and let the run continue, so `linkPath` still holds the
 * complete original. Clearing there would recursively delete a healthy
 * directory (and, since this arm is reached precisely when another process
 * holds it open, anything that process wrote after the copy into the repo,
 * which is in neither `shared/<name>` nor the backup). It also has no mirror
 * safety to buy: the next push should publish that full original, not skip it.
 *
 * The stage runs BEFORE the throw deliberately. Without it the caller's
 * `git add` is skipped and the user is left with `shared/<name>` on disk but
 * untracked, which no single command finishes.
 *
 * The recovery order is pull BEFORE push, and that order is load-bearing rather
 * than stylistic: a push mirrors the host path back over `shared/<name>` first,
 * so pushing while the local copy is missing or partial is what would undo the
 * adopt. `clearPartialCopy` removes the remnant when it can, and the message
 * says so when it cannot.
 *
 * The catch is deliberately broad, with no `err.code` dispatch: the copy
 * bottoms out in several different syscalls, each of which can raise a
 * different Windows errno for the same underlying lock, so narrowing would
 * miss real cases rather than filter noise. Breadth stops at deliberate
 * failures: a `NomadFatal` is staged and re-thrown untouched, keeping its own
 * message and exit code, because the one this path raises (the repo-file
 * against host-directory collision from `copyExtrasFilteredPreservingBy`) names
 * the only command that clears it, and wrapping it would append a contradictory
 * second instruction. Same discipline as `applyOneSharedLinkWin32`.
 *
 * The two flags travel in an options object rather than as positional
 * booleans. They mean unrelated things, they sat on either side of `stage`,
 * and the compiler cannot tell one `boolean` from another, so a swapped pair
 * would typecheck and then quietly report the wrong recovery: a backup that
 * was never written, and a clear of the intact original this phase exists to
 * prevent.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side path the copy could not be written to.
 * @param sharedTarget Repo-side source of the copy.
 * @param ts Backup timestamp, named only when a snapshot exists.
 * @param stage Stages `shared/<name>`; run before throwing, either way.
 * @param opts.snapshotted True when `backupBeforeWrite` actually wrote a snapshot.
 * @param opts.sourceRemoved False when the move's own removal of `linkPath`
 *   failed, so whatever is there is the complete original rather than a remnant.
 */
export function restoreWin32LocalCopy(
  name: string,
  linkPath: string,
  sharedTarget: string,
  ts: string,
  stage: () => void,
  opts: { snapshotted: boolean; sourceRemoved: boolean },
): void {
  try {
    copySharedLinkPull(sharedTarget, linkPath);
  } catch (err) {
    if (err instanceof NomadFatal) {
      // Re-thrown untouched, so a staging failure cannot ride along inside its
      // message; it gets its own line rather than being dropped.
      const fatalStageFailure = stageOrReport(stage);
      if (fatalStageFailure !== '') warn(`${name}:${fatalStageFailure}`);
      throw err;
    }
    const leftover = describeLeftoverAt(name, linkPath, opts.sourceRemoved);
    const stageFailure = stageOrReport(stage);
    const staged = stageFailure === '' ? ' and staged.' : `.${stageFailure}`;
    const recover = opts.snapshotted
      ? ` A copy of what it held before is under backup/${ts}/.`
      : '';
    throw new NomadFatal(
      `adopted ${name} into shared/${name}, but could not restore the local copy at ` +
        `${linkPath} (${errorText(err)}). The content is safe in the repo` +
        `${staged}${recover} Check its permissions, or whether another program has it ` +
        `open, then run \`nomad pull\` to recreate the local copy before your next ` +
        `\`nomad push\`.${leftover}`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
}

/**
 * Say what an uncleared partial `shared/<name>` will do to the NEXT run, which
 * is not the same thing on both platforms.
 *
 * On posix `adoptStopsEarly` (in `commands.adopt.ts`) refuses outright
 * (`would clobber`), so the
 * instruction is simply to remove it. On win32 it never gets that far:
 * `reportWin32AlreadyAdopted` runs first and fires on the mere existence of
 * `shared/<name>`, so a re-run reports the name as already adopted and exits 0
 * over a mid-copy fragment. Worse than the misreport is the hint that branch
 * prints, since following it copies the fragment over a `~/.claude/<name>` that
 * is still whole. Telling the user adopt would refuse, when on their platform
 * it will cheerfully claim success, is the one wording that could cost content.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side path, still intact, named in the win32 warning.
 * @returns A clause to append to the failure message.
 */
function describePartialShared(name: string, linkPath: string): string {
  if (process.platform === 'win32') {
    return (
      ` A partial shared/${name} may still be in the repo. Remove it before re-running: ` +
      `adopt reports any name whose shared/${name} already exists as adopted and does ` +
      `nothing, and the \`nomad pull\` it suggests would copy that fragment over ${linkPath}, ` +
      `which is still whole.`
    );
  }
  return (
    ` A partial shared/${name} may still be in the repo; remove it first, because adopt ` +
    `refuses to run while it is there.`
  );
}

/**
 * Copy `~/.claude/<name>` into `shared/<name>`, reporting a failure as this
 * command's own instead of as a crash.
 *
 * Nothing has been destroyed when this fails: the removal of the source is the
 * next step, so the honest report is that the host is untouched and the
 * command can simply be run again. What stands in the way of that re-run is
 * the partial `shared/<name>` a mid-copy failure leaves in the repo, which
 * `adoptStopsEarly` reacts to on sight (differently per platform, see
 * {@link describePartialShared}), so the clear runs first and the message only
 * describes the leftover when the clear did not take.
 *
 * The copy runs through `copyExtrasFiltered(..., NEVER_SYNC)`,
 * the same primitive and the same deny set the repo-side mirror
 * (`mirrorOneSharedName` in `links.mirror.ts`) already applies to this exact
 * destination, so a denied basename is never written here even if one
 * appears on the host after `refuseDeniedEntries`'s preflight scan has
 * already run. That filter is silent by construction, which is why
 * {@link refuseLateDeniedEntries} re-scans the source straight afterwards
 * rather than letting the removal take such an entry off the host unannounced.
 * The primitive's leading `rmSync(dst)` is a no-op on every
 * reachable call: `adoptStopsEarly` already refused the run if
 * `shared/<name>` existed. That removal executes inside this same `try`, so a
 * failure there is reported by this guard rather than raw-thrown. Two
 * behavior deltas versus the old bare `cpSync` are deliberate. The first is
 * the loss of `preserveTimestamps`: repo-side files get fresh mtimes, which
 * nothing reads. The second is `verbatimSymlinks: true`, which keeps a
 * relative symlink target as the literal string it is instead of rewriting
 * it to an absolute path anchored at the source, matching what the repo-side
 * mirror already does to this same destination. That second one is accepted
 * with its cost, not merely target-preserving: a link whose relative target
 * climbs OUT of the adopted tree (`../skills/x`) is now relative to the repo
 * rather than to `~/.claude/`, so it dangles where the old rewrite would have
 * kept it resolving. Consistency with the mirror wins because the alternative
 * is publishing an absolute host path into a repo every other host reads, and
 * `commands.adopt.test.ts` pins both halves of the behavior.
 *
 * The catch is deliberately broad, with no `err.code` dispatch, for the reason
 * given on `restoreWin32LocalCopy`: the copy bottoms out in several syscalls
 * that raise different errnos for the same underlying cause.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side source of the copy.
 * @param sharedTarget Repo-side destination.
 * @param repo Absolute path to the nomad repo root.
 */
export function copyIntoSharedOrFatal(
  name: string,
  linkPath: string,
  sharedTarget: string,
  repo: string,
): void {
  try {
    copyExtrasFiltered(linkPath, sharedTarget, NEVER_SYNC);
  } catch (err) {
    const leftover = clearPartialShared(sharedTarget, repo)
      ? ''
      : describePartialShared(name, linkPath);
    throw new NomadFatal(
      `could not copy ${linkPath} into shared/${name} (${errorText(err)}). ` +
        `Nothing was removed from ${linkPath}. Check its permissions, or whether ` +
        `another program has it open, then run \`nomad adopt ${name}\` again.${leftover}`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
}

/**
 * Refuse the move when a never-sync entry turns up under `linkPath` after the
 * preflight scan has already passed it, before the source is removed.
 *
 * The copy's filter is a backstop, not a report: it drops such an entry from
 * `shared/<name>` silently, and the very next step
 * (`removeAdoptSource`) then deletes the whole host tree, that entry
 * included. So the one window the filter exists to cover is also the one
 * window where a denied entry becomes a silent skip WITH the source removed,
 * which is precisely the outcome `refuseDeniedEntries` refuses in order to
 * prevent: taken off the host, absent from the repo, surviving only in a
 * backup snapshot nothing told the user about.
 *
 * The window is not microscopic either. It spans the backup snapshot of the
 * whole tree and the copy of the whole tree into the repo, so seconds on a
 * large one.
 *
 * Refusing here is close to free, which is what makes it the right answer:
 * `linkPath` is still whole at this point, so the only thing to undo is the
 * partial `shared/<name>`, and the message can still promise that nothing was
 * taken off the host. `clearPartialShared` does that undo for the same reason
 * {@link copyIntoSharedOrFatal} clears it, and the message describes the
 * leftover on the rare run where the clear does not take.
 *
 * @param name The name being adopted, for the message and the re-run hint.
 * @param linkPath Host-side source of the copy, re-scanned here.
 * @param sharedTarget Repo-side destination to clear before refusing.
 * @param repo Absolute path to the nomad repo root.
 * @throws {NomadFatal} `EXIT.GENERIC_FAILURE` when the re-scan finds a denied
 *   entry, or cannot finish.
 */
export function refuseLateDeniedEntries(
  name: string,
  linkPath: string,
  sharedTarget: string,
  repo: string,
): void {
  const untouched = `Nothing was removed from ${linkPath}.`;
  const late = scanOrFatal(name, linkPath, `${untouched}${describePartialShared(name, linkPath)}`);
  if (late.length === 0) return;
  const state = clearPartialShared(sharedTarget, repo)
    ? `shared/${name} was cleared, and nothing was removed from ${linkPath}.`
    : `${untouched}${describePartialShared(name, linkPath)}`;
  throw deniedEntriesRefusal(name, linkPath, late, {
    found: `never-sync content appeared under ${linkPath} after the preflight scan`,
    state,
  });
}

/**
 * Remove the adopted source, handing the caller the outcome instead of
 * throwing it.
 *
 * Split out because what a failure MEANS differs by platform (see
 * {@link reportSourceRemovalFailure}), and that decision does not belong in
 * the same body as the call.
 *
 * Answered by a re-probe rather than by the absence of a throw, the same
 * discipline {@link clearIfDirectChild} follows and for the same reason: on
 * win32 a delete can be accepted and still leave the entry in place until the
 * last handle closes. Trusting the missing throw there would carry on to a
 * copy-back onto a delete-pending directory, or on posix to `ensureSymlink`
 * against a live path, and hand the user a downstream error instead of the
 * specific report this decides between.
 *
 * A discriminated result rather than an empty-string sentinel, so a throw
 * carrying an empty (or absent) message cannot be read as success.
 *
 * Bounded to a direct child of `~/.claude/` for the reason spelled out on
 * {@link clearIfDirectChild}: this is the most destructive call in the module,
 * it is exported, and the rule that module states is that a recursive
 * force-remove earns its containment check where the call is rather than at the
 * entry point three guards away. `cmdAdopt` rejects any name carrying a path
 * separator or a `.`/`..` segment long before it builds `linkPath`, so the
 * refusal cannot fire through the command; it is here for a future caller that
 * reaches this export by another route. Refusing reports as a removal failure,
 * which is the safe direction: the caller then either stops (posix) or leaves
 * the path in place and says so (win32), rather than deleting something outside
 * the bound.
 *
 * @param linkPath Host-side source directory to remove.
 * @returns `{ ok: true }` once the path is confirmed gone, otherwise the reason.
 */
export function removeAdoptSource(linkPath: string): { ok: true } | { ok: false; message: string } {
  const resolved = resolve(linkPath);
  if (!isDirectChildOf(claudeHome(), resolved)) {
    return { ok: false, message: 'it is not a direct child of the configured Claude home' };
  }
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
  if (lexists(resolved)) {
    return { ok: false, message: 'the delete was accepted but the entry is still there' };
  }
  return { ok: true };
}

/**
 * Report a failed source removal as whatever the host state actually is,
 * which is not the same thing on both platforms.
 *
 * The copy into `shared/<name>` has already succeeded by the time this runs,
 * so the content is safe either way and what is left to decide is what the
 * host is now in the middle of:
 *
 * - **win32** ends up in exactly the state a SUCCESSFUL adopt produces there:
 *   a real copy at `~/.claude/<name>` beside a populated `shared/<name>`,
 *   because that platform has no unprivileged symlinks and copies instead. So
 *   this warns and returns, and the caller carries on into the copy-back and
 *   the stage. The copy-back is not wasted work masking a problem: its prune
 *   finds nothing to remove (`shared/<name>` was just copied FROM `linkPath`,
 *   so every entry it sees exists in the source) and its `cpSync` rewrites
 *   identical bytes. Failing here instead would exit non-zero on a correct
 *   host and invite the user to "fix" it by deleting content that should stay.
 *   The arm self-limits in practice: whatever blocked the delete usually
 *   blocks the copy-back too, which then fails through
 *   `restoreWin32LocalCopy` (told, via `sourceRemoved`, that what is at the
 *   path is the intact original and not a remnant to clear). What this arm
 *   saves is the case of a handle that blocks removing a directory while still
 *   allowing writes into it.
 * - **posix** ends up in a state nothing downstream accepts: a real directory
 *   where a symlink belongs, which `ensureSymlink` refuses (`exists and is not
 *   a symlink`) and every later `applySharedLinks` refuses the same way. So
 *   this stages and then throws, naming the leftover and pointing at the pull
 *   that clears it (`runAutoMovePasses` in `links.ts` backs a non-symlink up
 *   and removes it before linking, so the manual `rm` is the fallback, not the
 *   instruction).
 *
 * Staging before the throw is the same discipline `restoreWin32LocalCopy`
 * follows: without it the repo half of the move is on disk and untracked, and
 * no single command finishes it. A staging failure earns its own clause rather
 * than replacing the message it interrupted.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side path that could not be removed.
 * @param message The caught error's message, quoted verbatim.
 * @param stage Stages `shared/<name>`; run before throwing on posix.
 */
export function reportSourceRemovalFailure(
  name: string,
  linkPath: string,
  message: string,
  stage: () => void,
): void {
  if (process.platform === 'win32') {
    warn(
      `${name}: could not remove ${linkPath} (${message}); refreshing it from ` +
        `shared/${name} instead, which leaves the same result`,
    );
    return;
  }
  const stageFailure = stageOrReport(stage);
  const staged = stageFailure === '' ? ' and staged.' : `.${stageFailure}`;
  throw new NomadFatal(
    `adopted ${name} into shared/${name}, but could not remove the original at ` +
      `${linkPath} (${message}). It is a real directory where a symlink belongs, ` +
      `so nothing links to shared/${name} yet. The content is safe in the repo` +
      `${staged} Check its permissions, or whether another program has it open, ` +
      `then run \`nomad pull\`, which backs that directory up and replaces it with ` +
      `the symlink. Remove it by hand only if the same problem blocks the pull.`,
    { code: EXIT.GENERIC_FAILURE },
  );
}
