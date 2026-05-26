import { execFileSync } from 'node:child_process';

import { REPO_HOME } from './config.ts';

/**
 * Expand a repo-relative directory into its staged entries via
 * `git ls-files -z -- <dirRel>` (argv-array form, NUL-split for path
 * safety). Returns repo-relative POSIX paths for every staged file under
 * the directory, or an empty array when none are staged or `git` fails
 * (missing/corrupt index); the caller then falls through to the existing
 * per-entry idempotency guard rather than escalating to a FATAL.
 *
 * @param dirRel Repo-relative directory path (`shared/projects/<logical>/<id>`).
 */
export function expandStagedDir(dirRel: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', dirRel], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out
      .toString()
      .split('\0')
      .filter((p) => p !== '');
  } catch {
    return [];
  }
}

/**
 * Is `rel` (repo-relative path) present in the HEAD tree? Wraps
 * `git cat-file -e HEAD:<rel>`: exit 0 means tracked in HEAD,
 * non-zero means either no HEAD exists yet (empty repo) or the path is
 * only in the index (newly-staged-not-in-HEAD). `git ls-files
 * --error-unmatch` is NOT a HEAD-presence check; it matches anything in
 * the index too, which would misclassify newly-staged paths.
 *
 * The catch deliberately collapses three cases to `false`: (a) HEAD has
 * no commit yet (fresh `git init`), (b) HEAD is unresolvable / corrupt
 * (e.g., `.git/refs/heads/main` was deleted manually), and (c) the
 * specific path simply does not exist in a valid HEAD. Git produces the
 * same exit 128 and the same stderr (`fatal: invalid object name 'HEAD'`)
 * for (a) and (b), so a probe-based distinction would require additional
 * git-plumbing reads (`rev-parse --verify HEAD`, `.git/refs/heads/`
 * inspection) that are brittle and break the empty-repo path every
 * existing test runs through. The downstream `git rm --cached -f` is
 * idempotent and produces the user-intended unstage outcome regardless
 * of which case fired, so the collapsed return is intentional. Repo
 * health belongs to `nomad doctor`, not drop-session.
 */
export function isTrackedInHead(rel: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `rel` present in the index at all? Wraps `git ls-files -- <rel>` and
 * checks for non-empty stdout. Required for the Pitfall 7 idempotency
 * guard: a second invocation on the same id finds the file on disk (per
 * `existsSync`) but absent from the index, and must NOT call `git rm
 * --cached` on it (which would fail with exit 128).
 */
export function isInIndex(rel: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', rel], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim() !== '';
  } catch {
    return false;
  }
}
