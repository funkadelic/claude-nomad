import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_BASE, CLAUDE_HOME, REPO_HOME, SHARED_LINKS, type PathMap } from './config.ts';
import { isValidSharedDir } from './config.sharedDirs.guard.ts';
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
 * `path-map.json` (D-03).
 *
 * @param name Candidate name.
 * @param map Parsed path-map (sharedDirs membership source).
 * @returns True when name is a configured shared target.
 */
function isConfiguredTarget(name: string, map: PathMap): boolean {
  return (
    (SHARED_LINKS as readonly string[]).includes(name) || (map.sharedDirs?.includes(name) ?? false)
  );
}

/**
 * Return true when `name` is safe to adopt. Static `SHARED_LINKS` members
 * are pre-approved and bypass `isValidSharedDir` (which rejects RESERVED_SHARED,
 * overlapping with SHARED_LINKS). Candidate `sharedDirs` names must pass
 * `isValidSharedDir` to prevent path injection (D-00a).
 *
 * @param name Candidate name from the CLI argument.
 * @returns True when the name is safe for adopt processing.
 */
function isValidAdoptName(name: string): boolean {
  if ((SHARED_LINKS as readonly string[]).includes(name)) return true;
  return isValidSharedDir(name);
}

/**
 * Perform the actual backup -> copy -> remove -> relink -> stage sequence
 * once all preconditions have passed. Extracts the mutation block so the
 * top-level function stays under the cognitive-complexity threshold.
 *
 * @param name The validated, configured, real-directory name to adopt.
 * @param linkPath Absolute path of the source directory (`CLAUDE_HOME/<name>`).
 * @param sharedTarget Absolute path of the destination (`REPO_HOME/shared/<name>`).
 */
function performAdoptMove(name: string, linkPath: string, sharedTarget: string): void {
  const ts = freshBackupTs(BACKUP_BASE);

  // D-00c: backup before any mutation
  backupBeforeWrite(linkPath, ts);

  // D-00e, V-07: copy fully into shared/ BEFORE removing the source so a
  // mid-move crash cannot lose user content
  cpSync(linkPath, sharedTarget, { recursive: true, force: true, preserveTimestamps: true });
  rmSync(linkPath, { recursive: true, force: true });

  // D-01: recreate the symlink immediately on this host
  ensureSymlink(linkPath, sharedTarget);

  // D-02: targeted stage of shared/<name> only; never git add -A
  const rel = join('shared', name);
  gitOrFatal(['add', '--', rel], `git add shared/${name}`, REPO_HOME);

  log(`adopted ${name}; ${ADOPT_PUSH_HINT}`);
}

/**
 * Bring a pre-existing `~/.claude/<name>` directory into the nomad shared set.
 *
 * Validates `name`, enforces the precondition matrix, then performs:
 * backup -> copy-into-shared -> remove-source -> recreate-symlink ->
 * targeted `git add` -> print follow-up hint. Stops there: no auto-commit,
 * no push pipeline (D-02).
 *
 * Accepts only already-configured names: a static SHARED_LINKS member or a
 * `sharedDirs` entry already declared in `path-map.json`. adopt is a mover,
 * not a config editor; it never writes `path-map.json` (D-03).
 *
 * `--dry-run` reports the planned actions and performs zero filesystem or
 * git changes (D-00d, V-08).
 *
 * @param name The `~/.claude/<name>` directory to adopt.
 * @param opts.dryRun When true, log planned actions and return without mutation.
 */
export function cmdAdopt(name: string, opts: { dryRun?: boolean } = {}): void {
  const dryRun = opts.dryRun === true;

  // D-00a: validate name format (rejects path separators, NEVER_SYNC, and arbitrary
  // names that are not in SHARED_LINKS; SHARED_LINKS statics bypass isValidSharedDir
  // because RESERVED_SHARED overlaps with SHARED_LINKS by design)
  if (!isValidAdoptName(name)) {
    fail(`invalid name: ${JSON.stringify(name)}`);
    process.exit(1);
  }

  // D-03: confirm name is an already-configured shared target
  const map = readMapIfPresent(REPO_HOME);
  if (!isConfiguredTarget(name, map)) {
    fail(
      `${name}: not a configured shared target. ` +
        `Add it to sharedDirs in path-map.json first, then re-run adopt.`,
    );
    process.exit(1);
  }

  const linkPath = join(CLAUDE_HOME, name);
  const sharedTarget = join(REPO_HOME, 'shared', name);

  // D-00b precondition checks -- in order: absent, already symlink, would clobber
  if (!existsSync(linkPath)) {
    log(`${name}: nothing to adopt (not present in ~/.claude/)`);
    return;
  }
  if (lstatSync(linkPath).isSymbolicLink()) {
    log(`${name}: already adopted (already a symlink)`);
    return;
  }
  if (lexists(sharedTarget)) {
    fail(`${name}: shared/${name} already exists; would clobber. Remove it first.`);
    process.exit(1);
  }

  // D-00d: dry-run preview -- branch before any mutation
  if (dryRun) {
    const ts = freshBackupTs(BACKUP_BASE);
    log(`would backup: ${linkPath} -> backup/${ts}/${name}`);
    log(`would move: ${linkPath} -> shared/${name}`);
    log(`would stage: shared/${name}`);
    return;
  }

  /* c8 ignore start -- catch is defensive: performAdoptMove only throws on a git/fs fault */
  try {
    performAdoptMove(name, linkPath, sharedTarget);
  } catch (err) {
    if (!(err instanceof NomadFatal)) throw err;
    fail(err.message);
    process.exitCode = 1;
  }
  /* c8 ignore stop */
}
