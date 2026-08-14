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
import { fail, gitOrFatal, log, NomadFatal } from './utils.ts';
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
 * The caller reports the outcome rather than assuming it.
 *
 * A recursive force-remove earns a containment check at the point of use, not
 * only at the entry point. `cmdAdopt` already rejects any name carrying a path
 * separator or a `.`/`..` segment before it builds `linkPath`, so this cannot
 * fire today; it is here so the removal stays bounded to one direct child of
 * `~/.claude/` if a future caller reaches it by another route, and so the
 * bound is checkable where the destructive call is rather than three guards
 * away. Refusing reports as "not cleared", which is the safe direction: the
 * caller then warns against pushing.
 *
 * The bound is re-read from `claudeHome()` rather than taken from the caller,
 * so the check compares against the configured root instead of against the
 * same value the path was built from, which would make it vacuous.
 *
 * @param linkPath Host-side path to clear.
 * @returns True when the path is gone afterwards.
 */
function clearPartialCopy(linkPath: string): boolean {
  const resolved = resolve(linkPath);
  /* c8 ignore next -- unreachable: cmdAdopt's name guards run first */
  if (dirname(resolved) !== resolve(claudeHome())) return false;
  try {
    rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
 * Restore the host-side copy after a win32 move, failing loud rather than
 * crashing when the destination cannot be written.
 *
 * By the time this runs the move itself has already succeeded: the content is
 * in `shared/<name>` and the source is gone. So a failure here costs the local
 * copy, never the content, and the honest report is a `NomadFatal` naming the
 * path rather than either a crash report or a success message. `nomad adopt`
 * takes exactly one name per invocation, so there is no rest-of-the-list to
 * preserve by warning and continuing the way the pull's apply loop does
 * (`applyOneSharedLinkWin32` in `links.ts`).
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
 */
function restoreWin32LocalCopy(
  name: string,
  linkPath: string,
  sharedTarget: string,
  ts: string,
  snapshotted: boolean,
  stage: () => void,
): void {
  try {
    copySharedLinkPull(sharedTarget, linkPath);
  } catch (err) {
    if (err instanceof NomadFatal) {
      stageOrReport(stage);
      throw err;
    }
    const leftover = clearPartialCopy(linkPath)
      ? ''
      : ` A partial copy may still be at that path, so do NOT run \`nomad push\` before the pull succeeds: it would replace shared/${name} with the partial copy.`;
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
 * Perform the actual backup -> copy -> remove -> relink -> stage sequence
 * once all preconditions have passed. Extracts the mutation block so the
 * top-level function stays under the cognitive-complexity threshold.
 *
 * The copy-into-shared, remove-source, and targeted `git add` steps are
 * identical on every platform (copy BEFORE remove is already crash-safe on
 * both). Only the final step differs: on posix, `ensureSymlink` recreates the
 * symlink so `linkPath` keeps working; on win32 (no unprivileged symlink
 * support), `copySharedLinkPull` copies `sharedTarget` back into `linkPath`
 * as a real, deny-set-filtered copy so the host keeps a usable local
 * counterpart under the copy-sync model.
 *
 * The stage is a closure rather than a straight-line call because the win32
 * arm has to run it on its own failure path (see `restoreWin32LocalCopy`).
 * Handing it down means the success path still stages exactly once and the
 * failure path never double-adds.
 *
 * @param name The validated, configured, real-directory name to adopt.
 * @param linkPath Absolute path of the source directory (`CLAUDE_HOME/<name>`).
 * @param sharedTarget Absolute path of the destination (`REPO_HOME/shared/<name>`).
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

  // Copy fully into shared/ BEFORE removing the source so a
  // mid-move crash cannot lose user content
  cpSync(linkPath, sharedTarget, { recursive: true, force: true, preserveTimestamps: true });
  rmSync(linkPath, { recursive: true, force: true });

  // Targeted stage of shared/<name> only; never git add -A
  const rel = join('shared', name);
  const stage = (): void => gitOrFatal(['add', '--', rel], `git add shared/${name}`, repo);

  // Leave the host with a usable local counterpart: a real copy-back on
  // win32 (no unprivileged symlink support), a recreated symlink elsewhere.
  if (process.platform === 'win32') {
    restoreWin32LocalCopy(name, linkPath, sharedTarget, ts, snapshotted, stage);
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

  // A NomadFatal is this command's own reported failure (a git fault, or the
  // win32 copy-back guard in performAdoptMove), so it renders as one message
  // and its own exit code. Anything else is genuinely unexpected and belongs
  // in the crash report the top-level handler writes.
  try {
    performAdoptMove(name, linkPath, sharedTarget, repo, backup);
  } catch (err) {
    if (!(err instanceof NomadFatal)) throw err;
    fail(err.message);
    process.exitCode = err.code;
  }
}
