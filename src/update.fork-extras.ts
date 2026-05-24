import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';
import { whitelistedExtrasPaths } from './extras-sync.ts';
import { gitOrFatal, log, readPathMap } from './utils.ts';

/**
 * Pre-commit whitelisted extras before a fork merge so an untracked-overwrite
 * abort becomes a tracked-file merge (issue #112).
 *
 * When a fork host has untracked `shared/extras/<logical>/<dirname>/` content
 * that `upstream/main` also introduces, `git merge upstream/main` aborts
 * before creating any merge state ("untracked working tree files would be
 * overwritten by merge"). No `UU` is recorded, so the lone-lockfile
 * auto-resolve never fires and the merge surfaces as an opaque failure.
 * Staging alone is insufficient (git still refuses to overwrite staged-but-
 * uncommitted local changes); the overlap must be a committed tracked path so
 * the merge engine treats it as a content merge. After this commit, identical
 * extras merge cleanly (the normal sync case, leaving the lone `UU
 * package-lock.json` the existing auto-resolve handles) and divergent extras
 * surface a real, resolvable conflict instead of the abort.
 *
 * Scoped strictly to the whitelisted `shared/extras/` paths declared in
 * `path-map.json`; never a blanket `git add -A`. No-op when there is no
 * `path-map.json`, no declared extras, or none of the declared extras paths
 * exist on disk, and when staging produces no index change (nothing dirty).
 */
export function precommitForkExtras(): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) return;
  const map = readPathMap(mapPath);
  const candidates = whitelistedExtrasPaths(map).filter((p) => existsSync(join(REPO_HOME, p)));
  if (candidates.length === 0) return;

  gitOrFatal(['add', '--', ...candidates], 'git add extras', REPO_HOME);
  // Only commit when staging actually changed the index. The probe and commit
  // are BOTH path-scoped to the extras candidates so an unrelated staged change
  // present before update neither flips the dirty probe nor rides along in the
  // commit. `git diff --cached --quiet -- <candidates>` exits 0 when those paths
  // match HEAD (nothing to commit), 1 when they differ; avoids an empty-commit
  // failure when the extras were already tracked and unmodified.
  let dirty = false;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet', '--', ...candidates], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    dirty = true;
  }
  if (!dirty) return;
  gitOrFatal(
    ['commit', '-m', 'chore: stage local extras before upstream merge', '--', ...candidates],
    'git commit extras',
    REPO_HOME,
  );
  log(`staged local extras before merge: ${candidates.join(', ')}`);
}

/**
 * After a successful fork merge, commit a `package-lock.json` that `npm
 * install` regenerated and left uncommitted (secondary item of issue #112).
 *
 * The post-merge reinstall (`reinstallIfNeeded`) can rewrite the lockfile
 * when the merge changed dependencies, leaving working-tree drift that the
 * trailing `nomad doctor` reports as "uncommitted changes". This stages and
 * commits ONLY `package-lock.json` so the repo is clean after update. No-op
 * when the lockfile is absent or unchanged (the `git diff --quiet` probe
 * exits 0). Tightly scoped: never touches any other path.
 */
export function commitRegeneratedLockfile(): void {
  const lockfile = join(REPO_HOME, 'package-lock.json');
  if (!existsSync(lockfile)) return;
  // `git diff --quiet -- package-lock.json` exits 0 when the working tree
  // matches HEAD (no drift to commit), 1 when it differs.
  let drifted = false;
  try {
    execFileSync('git', ['diff', '--quiet', '--', 'package-lock.json'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    drifted = true;
  }
  if (!drifted) return;
  gitOrFatal(['add', '--', 'package-lock.json'], 'git add package-lock.json', REPO_HOME);
  gitOrFatal(
    [
      'commit',
      '-m',
      'chore: commit regenerated package-lock.json after update',
      '--',
      'package-lock.json',
    ],
    'git commit package-lock.json',
    REPO_HOME,
  );
  log('committed regenerated package-lock.json after update');
}
