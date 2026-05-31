import { execFileSync } from 'node:child_process';

import { REPO_HOME } from './config.ts';
import { ghAuthStatus, readOriginRemote, type SpawnSyncFn } from './gh-actions.ts';
import { die, log, NomadFatal } from './utils.ts';

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
 * Timeout for the network-bound `gh` calls in the onboarding create flow. These
 * hit the GitHub API (repo creation, user lookup) and may also refresh auth, so
 * a tight bound risks a false NomadFatal on a slow link. Generous on purpose:
 * this is a one-time, user-initiated step, not the soft doctor version probe.
 */
const GH_NETWORK_TIMEOUT_MS = 30_000;

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
  if (ghStatus === 'gh-probe-error') {
    die('could not verify gh CLI status (network issue?). Retry, or check `gh auth status`.');
  }
  if (ghStatus !== null) {
    die('gh CLI is not authenticated. Run `gh auth login` and retry.');
  }

  // Initialize REPO_HOME as a git repo so `git remote add` below has a
  // repository to write to. On a first host REPO_HOME is a brand-new empty
  // directory (just mkdir'd by cmdInit); without this `git remote add` fails
  // with "not a git repository". `git init` is idempotent: re-running on an
  // already-initialized repo reinitializes harmlessly and leaves the branch
  // and config untouched.
  try {
    run('git', ['init', '-b', 'main'], { cwd: REPO_HOME, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new NomadFatal(`git init failed: ${e.message}`);
  }

  // Create the private repo on GitHub. When the repo already exists on the
  // account, gh exits non-zero; treat that as a no-op and fall through to wire
  // origin rather than failing (D-09 idempotency: a prior run may have created
  // the repo but died before `git remote add`). Any other failure is fatal.
  try {
    run('gh', ['repo', 'create', repoName, '--private'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_NETWORK_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const detail = String(e.stderr ?? '') + e.message;
    if (!/already exists/i.test(detail)) {
      throw new NomadFatal(`gh repo create failed: ${e.message}`);
    }
    log(`repo ${repoName} already exists on your account; reusing it and wiring origin`);
  }

  // Resolve the authenticated user's login for the remote URL.
  let owner: string;
  try {
    owner = run('gh', ['api', 'user', '--jq', '.login'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GH_NETWORK_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new NomadFatal(`gh api user failed: ${e.message}`);
  }

  // Guard an empty or null login: `gh api user --jq .login` yields an empty
  // string or the literal "null" when the field is absent. Either would wire a
  // malformed remote (git accepts any URL string) that fails confusingly only
  // at first push, so fail fast here with a clear message instead.
  if (owner.length === 0 || owner === 'null') {
    throw new NomadFatal('gh api user returned an empty login; cannot wire origin remote.');
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
