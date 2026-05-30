import { execFileSync } from 'node:child_process';

import { REPO_HOME } from './config.ts';
import { ghAuthStatus, readOriginRemote, type SpawnSyncFn } from './gh-actions.ts';
import { NomadFatal } from './utils.ts';
import { die, log } from './utils.ts';

/**
 * Default private GitHub repository name used by `ensureOriginRepo` when no
 * explicit `--repo <name>` flag is provided. Users can override with
 * `nomad init --repo <name>`.
 */
export const DEFAULT_REPO_NAME = 'claude-nomad-config';

/**
 * Validate a user-supplied GitHub repository name. Accepts only characters
 * that GitHub allows: alphanumerics, hyphens, underscores, and dots, up to
 * 100 characters. This blocks argument-injection or path-escape attempts when
 * the name flows into subprocess argv (T-32-06).
 */
function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name);
}

/**
 * Ensure REPO_HOME has a GitHub `origin` remote. When one already exists the
 * function is a no-op (D-09 idempotency). When none exists, a new private
 * repository named `repoName` is created via `gh repo create`, the owner is
 * resolved from `gh api user`, and `git remote add origin` is wired into
 * REPO_HOME. All subprocess calls use the argv-array form via the injectable
 * `run` runner; no shell strings are used (T-32-06).
 *
 * `gh` is a hard prerequisite on this path: missing or unauthenticated `gh`
 * results in a `NomadFatal` (D-08), not a soft tip.
 *
 * @param repoName - The GitHub repository name to create (validated by
 *   `isValidRepoName` before any subprocess call).
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
export function ensureOriginRepo(repoName: string, run: SpawnSyncFn = execFileSync): void {
  if (!isValidRepoName(repoName)) {
    die(
      `invalid repo name: ${JSON.stringify(repoName)}. Use only letters, digits, hyphens, underscores, and dots (1-100 chars).`,
    );
  }

  // Fast idempotency path: if origin is already wired, nothing to do (D-09).
  try {
    readOriginRemote(REPO_HOME, run);
    return;
  } catch {
    // No origin configured; fall through to the create flow.
  }

  // gh is a hard prerequisite when no origin is present (D-08).
  const ghStatus = ghAuthStatus(run);
  if (ghStatus === 'gh-not-installed') {
    die('gh CLI is required for nomad init. Install: https://cli.github.com');
  }
  if (ghStatus !== null) {
    die('gh CLI is not authenticated. Run `gh auth login` and retry.');
  }

  // Create the private repo on GitHub.
  try {
    run('gh', ['repo', 'create', repoName, '--private'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new NomadFatal(`gh repo create failed: ${e.message}`);
  }

  // Resolve the authenticated user's login for the remote URL.
  let owner: string;
  try {
    owner = run('gh', ['api', 'user', '--jq', '.login'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new NomadFatal(`gh api user failed: ${e.message}`);
  }

  // Wire origin in the local git working tree.
  try {
    run('git', ['remote', 'add', 'origin', `git@github.com:${owner}/${repoName}.git`], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new NomadFatal(`git remote add failed: ${e.message}`);
  }

  log(`created private repo ${owner}/${repoName} and wired origin`);
}
