import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  backupBase,
  claudeHome,
  repoHome,
  sharedDirEntries,
  SHARED_LINKS,
  type PathMap,
} from './config.ts';
import { isValidSharedDir, validateSharedDirEntry } from './config.sharedDirs.guard.ts';
import { EXIT } from './exit-codes.ts';
import { copySharedLinkPull } from './links.ts';
import { fail, gitOrFatal, log, warn, NomadFatal } from './utils.ts';
import { backupBeforeWrite, ensureSymlink, freshBackupTs } from './utils.fs.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Follow-up hint printed after a successful adopt. Exported so Plan 02's
 * doctor hint can reuse the exact literal without duplicating the string.
 */
export const ADOPT_PUSH_HINT = 'run `nomad push` to share with other hosts';

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
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `path-map.json` if present; fall back to an empty map when absent.
 * Adopt reads sharedDirs for membership only; it never writes path-map.json.
 *
 * @param repoHome Absolute path to the nomad repo root.
 * @returns The parsed PathMap, or `{ projects: {} }` when path-map.json is absent.
 */
function readMapIfPresent(repoHome: string): PathMap {
  const mapPath = join(repoHome, 'path-map.json');
  return existsSync(mapPath) ? readPathMap(mapPath) : { projects: {} };
}

/**
 * Return true when `name` is an already-configured shared target: either a
 * static `SHARED_LINKS` member or a `sharedDirs` entry declared in
 * `path-map.json`. This is a read-only membership check; adopt never writes
 * `path-map.json`.
 *
 * @param name Candidate name.
 * @param map Parsed path-map (sharedDirs membership source).
 * @returns True when name is a configured shared target.
 */
function isConfiguredTarget(name: string, map: PathMap): boolean {
  return (SHARED_LINKS as readonly string[]).includes(name) || sharedDirEntries(map).includes(name);
}

/**
 * Return true when `name` is safe to adopt. Static `SHARED_LINKS` members
 * are pre-approved and bypass `isValidSharedDir` (which rejects RESERVED_SHARED,
 * overlapping with SHARED_LINKS). Candidate `sharedDirs` names must pass
 * `isValidSharedDir` to prevent path injection.
 *
 * @param name Candidate name from the CLI argument.
 * @returns True when the name is safe for adopt processing.
 */
function isValidAdoptName(name: string): boolean {
  if ((SHARED_LINKS as readonly string[]).includes(name)) return true;
  return isValidSharedDir(name);
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
 * Report the win32 already-adopted state, when that is what this is.
 *
 * win32 has no unprivileged symlink support, so a real (non-symlink) copy at
 * `linkPath` IS the healthy adopted state there once `shared/<name>` exists,
 * and so is no local entry at all: the content is in the repo and one
 * `nomad pull` materializes it. Both are reported the same way, which is why
 * this is a helper rather than a single branch: `cmdAdopt` asks it once for the
 * absent case and once for the real-entry case, on either side of the
 * symlink arm that has to stay ahead of both.
 *
 * @param name The name being adopted, for the message.
 * @param sharedTarget Repo-side `shared/<name>` path to probe.
 * @returns True when the message was printed and the caller should return.
 */
function reportWin32AlreadyAdopted(name: string, sharedTarget: string): boolean {
  if (process.platform !== 'win32' || !lexists(sharedTarget)) return false;
  log(`${name}: already adopted (win32 copy-sync); run \`nomad pull\` to refresh the local copy`);
  return true;
}

/**
 * Run the precondition matrix, reporting whether adopt should stop here.
 *
 * Order is load-carrying and reads as most-specific-state-first: an absent
 * local entry, then a symlink, then the win32 copy-sync state, then the
 * would-clobber refusal.
 *
 * The win32 check appears twice by design, on either side of the symlink arm.
 * An absent local entry whose `shared/<name>` exists is the state a failed
 * copy-back leaves behind (that path clears the partial copy while the repo
 * side stays populated), and answering "nothing to adopt" there would hide the
 * `nomad pull` that brings the content back. But a real symlink at `linkPath`
 * is the more specific state, and on a win32 host with Developer Mode (or an
 * install predating the copy-sync model) both conditions hold at once, so the
 * symlink arm has to win there or the message names the wrong mechanism.
 *
 * @param name The name being adopted.
 * @param linkPath Absolute `CLAUDE_HOME/<name>`.
 * @param sharedTarget Absolute `REPO_HOME/shared/<name>`.
 * @returns True when a message was printed and adopt should return.
 */
function adoptStopsEarly(name: string, linkPath: string, sharedTarget: string): boolean {
  if (!existsSync(linkPath)) {
    if (reportWin32AlreadyAdopted(name, sharedTarget)) return true;
    log(`${name}: nothing to adopt (not present in ~/.claude/)`);
    return true;
  }
  if (lstatSync(linkPath).isSymbolicLink()) {
    log(`${name}: already adopted (already a symlink)`);
    return true;
  }
  if (reportWin32AlreadyAdopted(name, sharedTarget)) return true;
  if (lexists(sharedTarget)) {
    fail(`${name}: shared/${name} already exists; would clobber. Remove it first.`);
    process.exit(1);
  }
  return false;
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
 * worth doing rather than reporting: `adoptStopsEarly` turns any run whose
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
    return ` Staging it failed too (${(err as Error).message}), so it is in the repo but not staged.`;
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
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side path the copy could not be written to.
 * @param sharedTarget Repo-side source of the copy.
 * @param ts Backup timestamp, named only when a snapshot exists.
 * @param snapshotted True when `backupBeforeWrite` actually wrote a snapshot.
 * @param stage Stages `shared/<name>`; run before throwing, either way.
 * @param sourceRemoved False when the move's own removal of `linkPath` failed,
 *   so whatever is there is the complete original rather than a remnant.
 */
function restoreWin32LocalCopy(
  name: string,
  linkPath: string,
  sharedTarget: string,
  ts: string,
  snapshotted: boolean,
  stage: () => void,
  sourceRemoved: boolean,
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
    const leftover = describeLeftoverAt(name, linkPath, sourceRemoved);
    const stageFailure = stageOrReport(stage);
    const staged = stageFailure === '' ? ' and staged.' : `.${stageFailure}`;
    const recover = snapshotted ? ` A copy of what it held before is under backup/${ts}/.` : '';
    throw new NomadFatal(
      `adopted ${name} into shared/${name}, but could not restore the local copy at ` +
        `${linkPath} (${(err as Error).message}). The content is safe in the repo` +
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
 * On posix `adoptStopsEarly` refuses outright (`would clobber`), so the
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
 * The catch is deliberately broad, with no `err.code` dispatch, for the reason
 * given on `restoreWin32LocalCopy`: the copy bottoms out in several syscalls
 * that raise different errnos for the same underlying cause.
 *
 * @param name The name being adopted, for the message.
 * @param linkPath Host-side source of the copy.
 * @param sharedTarget Repo-side destination.
 * @param repo Absolute path to the nomad repo root.
 */
function copyIntoSharedOrFatal(
  name: string,
  linkPath: string,
  sharedTarget: string,
  repo: string,
): void {
  try {
    cpSync(linkPath, sharedTarget, { recursive: true, force: true, preserveTimestamps: true });
  } catch (err) {
    const leftover = clearPartialShared(sharedTarget, repo)
      ? ''
      : describePartialShared(name, linkPath);
    throw new NomadFatal(
      `could not copy ${linkPath} into shared/${name} (${(err as Error).message}). ` +
        `Nothing was removed from ${linkPath}. Check its permissions, or whether ` +
        `another program has it open, then run \`nomad adopt ${name}\` again.${leftover}`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }
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
 * @param linkPath Host-side source directory to remove.
 * @returns `{ ok: true }` once the path is confirmed gone, otherwise the reason.
 */
function removeAdoptSource(linkPath: string): { ok: true } | { ok: false; message: string } {
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, message: String((err as Error | undefined)?.message ?? err) };
  }
  if (lexists(linkPath)) {
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
function reportSourceRemovalFailure(
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

/**
 * Perform the actual backup -> copy -> remove -> relink -> stage sequence
 * once all preconditions have passed. Extracts the mutation block so the
 * top-level function stays under the cognitive-complexity threshold.
 *
 * The copy-into-shared, remove-source, and targeted `git add` steps run on
 * every platform (copy BEFORE remove is already crash-safe on both). Only the
 * restore step differs: on posix, `ensureSymlink` recreates the symlink so
 * `linkPath` keeps working; on win32 (no unprivileged symlink support),
 * `copySharedLinkPull` copies `sharedTarget` back into `linkPath` as a real,
 * deny-set-filtered copy so the host keeps a usable local counterpart under
 * the copy-sync model.
 *
 * Each of the three filesystem steps reports its own failure rather than
 * throwing raw, because each leaves the host in a different place and only one
 * of them is a failure on both platforms. See `copyIntoSharedOrFatal`
 * (nothing destroyed yet), `reportSourceRemovalFailure` (the platform split),
 * and `restoreWin32LocalCopy` (the content is already safe in the repo).
 *
 * The stage is a closure rather than a straight-line call because two of those
 * failure paths have to run it themselves. Handing it down means the success
 * path still stages exactly once and no failure path double-adds.
 *
 * @param name The validated, configured, real-directory name to adopt.
 * @param linkPath Absolute path of the source directory (`CLAUDE_HOME/<name>`).
 * @param sharedTarget Absolute path of the destination (`REPO_HOME/shared/<name>`).
 * @param repo Absolute path to the nomad repo root.
 * @param backup Absolute path to the backup root.
 */
function performAdoptMove(
  name: string,
  linkPath: string,
  sharedTarget: string,
  repo: string,
  backup: string,
): void {
  const ts = freshBackupTs(backup);

  // Back up before any mutation. The return value distinguishes a real
  // snapshot from a no-op, so a later failure never advertises a backup dir
  // that holds nothing.
  const snapshotted = backupBeforeWrite(linkPath, ts);

  // Targeted stage of shared/<name> only; never git add -A. Hoisted above the
  // mutation because both guards below have to run it on their own failure
  // path, so the repo half of the move is never left on disk and untracked.
  const rel = join('shared', name);
  const stage = (): void => gitOrFatal(['add', '--', rel], `git add shared/${name}`, repo);

  // Copy fully into shared/ BEFORE removing the source so a
  // mid-move crash cannot lose user content
  copyIntoSharedOrFatal(name, linkPath, sharedTarget, repo);
  const removal = removeAdoptSource(linkPath);
  if (!removal.ok) reportSourceRemovalFailure(name, linkPath, removal.message, stage);

  // Leave the host with a usable local counterpart: a real copy-back on
  // win32 (no unprivileged symlink support), a recreated symlink elsewhere.
  // Only win32 reaches here with a failed removal, and the copy-back guard
  // has to know that so it never clears the intact original.
  if (process.platform === 'win32') {
    restoreWin32LocalCopy(name, linkPath, sharedTarget, ts, snapshotted, stage, removal.ok);
  } else {
    ensureSymlink(linkPath, sharedTarget);
  }

  stage();

  log(`adopted ${name}; ${ADOPT_PUSH_HINT}`);
}

/**
 * Bring a pre-existing `~/.claude/<name>` directory into the nomad shared set.
 *
 * Validates `name`, enforces the precondition matrix, then performs:
 * backup -> copy-into-shared -> remove-source -> recreate-symlink (posix) or
 * copy-back (win32, see {@link performAdoptMove}) -> targeted `git add` ->
 * print follow-up hint. Stops there: no auto-commit, no push pipeline.
 *
 * Accepts only already-configured names: a static SHARED_LINKS member or a
 * `sharedDirs` entry already declared in `path-map.json`. adopt is a mover,
 * not a config editor; it never writes `path-map.json`.
 *
 * `--dry-run` reports the planned actions and performs zero filesystem or
 * git changes.
 *
 * @param name The `~/.claude/<name>` directory to adopt.
 * @param opts.dryRun When true, log planned actions and return without mutation.
 */
export function cmdAdopt(name: string, opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;

  // adopt is the one entry point where the user explicitly named this
  // directory, so a quiet skip here is the confusing outcome: hard-fail
  // instead of falling through to the generic invalid-name path below.
  // EXIT.GENERIC_FAILURE preserves the exit code the adjacent invalid-name
  // path already returns; EXIT.USAGE is reserved for bad argv shapes, not a
  // rejected positional value.
  const rejection = validateSharedDirEntry(name);
  if (rejection !== null && rejection.reason === 'secret-shaped') {
    throw new NomadFatal(
      `cannot adopt ${JSON.stringify(name)}: ${rejection.message}. If it is listed in sharedDirs in path-map.json, remove it there too.`,
      { code: EXIT.GENERIC_FAILURE },
    );
  }

  // Validate name format (rejects path separators, NEVER_SYNC, and arbitrary
  // names that are not in SHARED_LINKS; SHARED_LINKS statics bypass isValidSharedDir
  // because RESERVED_SHARED overlaps with SHARED_LINKS by design)
  if (!isValidAdoptName(name)) {
    fail(`invalid name: ${JSON.stringify(name)}`);
    process.exit(1);
  }

  // Resolve roots once per command invocation to avoid a time-of-check/time-of-use
  // race: resolving twice could observe a different filesystem state between the
  // check and the use.
  const repo = repoHome();
  const claude = claudeHome();
  const backup = backupBase();

  // Confirm name is an already-configured shared target
  const map = readMapIfPresent(repo);
  if (!isConfiguredTarget(name, map)) {
    fail(
      `${name}: not a configured shared target. ` +
        `Add it to sharedDirs in path-map.json first, then re-run adopt.`,
    );
    process.exit(1);
  }

  const linkPath = join(claude, name);
  const sharedTarget = join(repo, 'shared', name);

  if (adoptStopsEarly(name, linkPath, sharedTarget)) return;

  // Dry-run preview -- branch before any mutation
  if (dryRun) {
    const ts = freshBackupTs(backup);
    log(`would backup: ${linkPath} -> backup/${ts}/${name}`);
    log(`would move: ${linkPath} -> shared/${name}`);
    log(
      process.platform === 'win32'
        ? `would copy back: shared/${name} -> ${linkPath} (win32 copy-sync)`
        : `would relink: ${linkPath} -> shared/${name}`,
    );
    log(`would stage: shared/${name}`);
    return;
  }

  // A NomadFatal is this command's own reported failure (a git fault, or any
  // of performAdoptMove's three filesystem guards), so it renders as one
  // message and its own exit code. Anything else is genuinely unexpected and
  // belongs in the crash report the top-level handler writes.
  try {
    performAdoptMove(name, linkPath, sharedTarget, repo, backup);
  } catch (err) {
    if (!(err instanceof NomadFatal)) throw err;
    fail(err.message);
    process.exitCode = err.code;
  }
}
