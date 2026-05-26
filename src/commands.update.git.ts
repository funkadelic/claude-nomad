import { execFileSync } from 'node:child_process';

import { REPO_HOME } from './config.ts';
import { log, NomadFatal } from './utils.ts';

/**
 * Get the current Git branch name for the repository at REPO_HOME.
 *
 * Wraps the failure path so a corrupt or missing `.git` directory surfaces as
 * ``✗ ...`` via the top-level dispatcher's `NomadFatal` catch
 * rather than a raw `ExecException` stack trace.
 *
 * @returns The current branch name (trimmed).
 * @throws NomadFatal when the git command fails; if the command produced stderr, that stderr is written to process.stderr before the exception is thrown.
 */
export function currentBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal('git rev-parse --abbrev-ref HEAD failed');
  }
}

/**
 * Read and return the current `HEAD` commit SHA from the repository.
 *
 * Used to pin the pre-update commit so the post-update lockfile diff is
 * exact regardless of whether the pull was a fast-forward, a no-op, or a
 * merge. `HEAD@{1}` is unreliable here: a no-op `git pull --ff-only` does
 * not always write a reflog entry, and a freshly cloned repo has no
 * `HEAD@{1}` at all.
 *
 * @returns The `HEAD` commit SHA as a trimmed string.
 * @throws NomadFatal if `git rev-parse HEAD` fails (stderr is written to stderr when present).
 */
export function headSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal('git rev-parse HEAD failed');
  }
}

/**
 * List files changed between the given commit and the current HEAD.
 *
 * @param beforeSha - Commit SHA to compare against HEAD
 * @returns An array of file paths changed between `beforeSha` and `HEAD`; an empty array if there are no changes
 */
export function changedFilesSince(beforeSha: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', `${beforeSha}..HEAD`], {
    cwd: REPO_HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return out.split('\n').filter((line) => line !== '');
}

/**
 * Run `npm install` in the repository only if `package-lock.json` changed since a given commit.
 *
 * If `package-lock.json` did not change between `beforeSha` and `HEAD`, logs
 * a skip message; otherwise runs `npm install` with working directory set to
 * `REPO_HOME`. Routing through `execFileSync` (no shell) keeps the call
 * mockable in tests and prevents any chance of argv injection.
 *
 * @param beforeSha - Commit SHA to compare against `HEAD` when determining whether the lockfile changed
 */
export function reinstallIfNeeded(beforeSha: string): void {
  const changed = changedFilesSince(beforeSha);
  if (!changed.includes('package-lock.json')) {
    log('skipping npm install (lockfile unchanged)');
    return;
  }
  log('package-lock.json changed, running npm install');
  execFileSync('npm', ['install'], { cwd: REPO_HOME, stdio: 'inherit' });
}
