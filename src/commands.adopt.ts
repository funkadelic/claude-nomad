import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import {
  copyIntoSharedOrFatal,
  lexists,
  refuseLateDeniedEntries,
  removeAdoptSource,
  reportSourceRemovalFailure,
  restoreWin32LocalCopy,
} from './commands.adopt.recover.ts';
import { refuseDeniedEntries } from './commands.adopt.scan.ts';
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
import { classifyPresence, isUnusableTarget } from './fs-presence.ts';
import { fail, gitOrFatal, log, NomadFatal } from './utils.ts';
import { backupBeforeWrite, ensureSymlink, freshBackupTs } from './utils.fs.ts';
import { acquireLock, releaseLock } from './utils.lockfile.ts';
import { readPathMap } from './utils.json.ts';

/**
 * Follow-up hint printed after a successful adopt. Exported so Plan 02's
 * doctor hint can reuse the exact literal without duplicating the string.
 */
export const ADOPT_PUSH_HINT = 'run `nomad push` to share with other hosts';

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
 * Refuse a name whose `shared/<name>` cannot be used, and end the process.
 *
 * Called only from {@link reportWin32AlreadyAdopted} once the repo-side
 * target has classified as `dangling` or `unknown`
 * ({@link isUnusableTarget}): a broken repo pointer, or one that could not be
 * stat-ed at all. Reporting this as "already adopted" (the old behavior)
 * was wrong twice over: nothing was actually adopted, and `nomad pull`
 * cannot repair it either, because `copySharedLinkPull` copies FROM
 * `shared/<name>`, so a pull against an unresolvable one has nothing to
 * copy. A WARN at exit 0 was rejected for the same reason auto-repair was:
 * it would leave a scripted caller unable to tell this no-op apart from a
 * real success, and the entry adopt would have to delete to auto-repair is
 * committed repo state on a name adopt did not just move.
 *
 * @param name The name being adopted, for the message.
 * @returns Never returns; ends the process at `EXIT.GENERIC_FAILURE`.
 */
function refuseDanglingSharedTarget(name: string): never {
  fail(
    `${name}: shared/${name} does not resolve, so adopting would publish nothing. ` +
      `Remove shared/${name} from the repo, or restore what it points at, then re-run adopt.`,
  );
  process.exit(EXIT.GENERIC_FAILURE);
}

/**
 * Report the win32 already-adopted state, when that is what this is, or
 * refuse a `shared/<name>` that cannot be used.
 *
 * win32 has no unprivileged symlink support, so a real (non-symlink) copy at
 * `linkPath` IS the healthy adopted state there once `shared/<name>` exists,
 * and so is no local entry at all: the content is in the repo and one
 * `nomad pull` materializes it. Both are reported the same way, which is why
 * this is a helper rather than a single branch: `cmdAdopt` asks it once for the
 * absent case and once for the real-entry case, on either side of the
 * symlink arm that has to stay ahead of both.
 *
 * Three outcomes rather than two. The platform gate stays a first-line early
 * return so every non-win32 caller keeps the same shape as before. Once past
 * it, `sharedTarget` is classified once: `absent` falls through to `false`
 * exactly as before (this is the not-yet-adopted case, still the caller's to
 * report), an unusable state (`dangling` or `unknown`) ends the process via
 * {@link refuseDanglingSharedTarget}, and anything else (a live, resolving
 * entry) is the genuine already-adopted state and keeps the original message.
 *
 * @param name The name being adopted, for the message.
 * @param sharedTarget Repo-side `shared/<name>` path to probe.
 * @returns True when the message was printed and the caller should return.
 *   Never returns `false` after printing a refusal: {@link refuseDanglingSharedTarget}
 *   ends the process instead.
 */
function reportWin32AlreadyAdopted(name: string, sharedTarget: string): boolean {
  if (process.platform !== 'win32') return false;
  const state = classifyPresence(sharedTarget);
  if (state === 'absent') return false;
  if (isUnusableTarget(state)) refuseDanglingSharedTarget(name);
  log(`${name}: already adopted (win32 copy-sync); run \`nomad pull\` to refresh the local copy`);
  return true;
}

/**
 * Describe the already-a-symlink state at `linkPath`, naming a broken
 * `shared/<name>` when that is what is there.
 *
 * `adoptStopsEarly`'s already-a-symlink branch checks only
 * `lstatSync(linkPath).isSymbolicLink()` and never probed `sharedTarget`, so
 * it reported "already adopted" even once the target had gone dangling. This
 * folds in the same classification the win32 refusal uses, but does NOT
 * inherit its exit-1 treatment: a write through a genuinely broken posix
 * symlink fails loudly at the OS level, so there is no silent data loss to
 * prevent here and no scripted-caller ambiguity to resolve. The two refusal
 * semantics stay deliberately distinct, and this branch is reached on EVERY
 * platform, unlike the win32-gated refusal above.
 *
 * `dangling` specifically, rather than {@link isUnusableTarget}: the second
 * wording asserts that the link is broken, which an unreadable-but-present
 * `shared/<name>` (the `unknown` state) has not been shown to be.
 *
 * @param name The name being adopted, for the message.
 * @param sharedTarget Repo-side `shared/<name>` path to probe.
 * @returns The message to log; unchanged wording when the target resolves.
 */
function alreadySymlinkMessage(name: string, sharedTarget: string): string {
  if (classifyPresence(sharedTarget) !== 'dangling') {
    return `${name}: already adopted (already a symlink)`;
  }
  return (
    `${name}: already a symlink, but shared/${name} does not resolve, so the link is broken. ` +
    `Restore shared/${name} in the repo, or remove ~/.claude/${name} and re-run adopt`
  );
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
 * `reportWin32AlreadyAdopted` now has a third outcome that ends the process
 * (an unusable `shared/<name>` is refused rather than reported adopted), so
 * both of its call sites below carry that refusal too, without either one
 * changing shape.
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
    log(alreadySymlinkMessage(name, sharedTarget));
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
 * `refuseLateDeniedEntries` sits between the copy and the removal for the
 * same reason the order of those two is what it is: it is the last moment at
 * which the host tree is still whole, so a never-sync entry that arrived
 * after the preflight scan can be refused rather than silently filtered out
 * of the repo and then deleted off the host with everything else. It is handed
 * the backup outcome because the snapshot above it is unfiltered, so its
 * refusal has to name the one copy of the denied entry the run did make.
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

  // The copy filters out a denied entry that arrived since the preflight scan,
  // and says nothing about it; the removal below would then take that same
  // entry off the host. The source is still whole right here, so this is the
  // last point where refusing costs nothing.
  refuseLateDeniedEntries(name, linkPath, sharedTarget, repo, { snapshotted, ts });

  const removal = removeAdoptSource(linkPath);
  if (!removal.ok) reportSourceRemovalFailure(name, linkPath, removal.message, stage);

  // Leave the host with a usable local counterpart: a real copy-back on
  // win32 (no unprivileged symlink support), a recreated symlink elsewhere.
  // Only win32 reaches here with a failed removal, and the copy-back guard
  // has to know that so it never clears the intact original.
  if (process.platform === 'win32') {
    restoreWin32LocalCopy(name, linkPath, sharedTarget, ts, stage, {
      snapshotted,
      sourceRemoved: removal.ok,
    });
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

  // A dry run reads and prints, so it stays lock-free. A real one takes the
  // same lock as pull, push and sync BEFORE its preflight, not just around the
  // move: `adoptStopsEarly` and `refuseDeniedEntries` read the host tree and
  // the repo, `performAdoptMove` does not re-check what they concluded, and a
  // concurrent pull rewrites exactly those two paths. Locking only the move
  // would let it act on a preflight answer that stopped being true.
  if (dryRun) {
    adoptPreflightAndMove(name, linkPath, sharedTarget, repo, backup, true);
    return;
  }
  const handle = acquireLock('adopt');
  if (handle === null) process.exit(EXIT.SUCCESS);
  try {
    adoptPreflightAndMove(name, linkPath, sharedTarget, repo, backup, false);
  } finally {
    releaseLock(handle);
  }
}

/**
 * The preflight checks and, on a real run, the move itself. Split out of
 * {@link cmdAdopt} so a wet run can hold the lock across both without the
 * dry-run preview taking one.
 *
 * @param name - The validated, configured directory name to adopt.
 * @param linkPath - Absolute path of the source directory (`CLAUDE_HOME/<name>`).
 * @param sharedTarget - Absolute path of the destination (`REPO_HOME/shared/<name>`).
 * @param repo - Absolute path to the nomad repo root.
 * @param backup - Absolute path to the backup root.
 * @param dryRun - Preview only; print what a real run would do and change nothing.
 */
function adoptPreflightAndMove(
  name: string,
  linkPath: string,
  sharedTarget: string,
  repo: string,
  backup: string,
  dryRun: boolean,
): void {
  if (adoptStopsEarly(name, linkPath, sharedTarget)) return;

  // Ahead of both the backup and the dry-run branch, so a refusal raised
  // here means literally nothing has changed yet; a name whose host tree is
  // clean falls straight through.
  refuseDeniedEntries(name, linkPath);

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
