import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

/**
 * GitHub repo owner/name pair parsed from a remote URL. Used by
 * `cmdInit`'s auto-disable hook and `nomad doctor`'s mirror-Actions check.
 */
export type GhRepoRef = { owner: string; repo: string };

/**
 * Reason `ghAuthStatus` returned without success. Distinguishes the two
 * actionable failure modes so callers can print useful tips.
 */
export type GhUnavailableReason = 'gh-not-installed' | 'gh-not-authed';

/**
 * Injectable subprocess runner so tests can mock without `vi.doMock` and
 * without touching `execFileSync` on the real shell. Default binds to
 * `child_process.execFileSync` with the same signature.
 */
export type SpawnSyncFn = (
  bin: string,
  args: readonly string[],
  opts?: ExecFileSyncOptions,
) => Buffer | string;

/**
 * Maximum time in milliseconds to wait for a `gh` CLI subprocess. Prevents
 * `nomad init` from hanging indefinitely on a slow or captive-portal network;
 * `execFileSync` throws `ETIMEDOUT` on expiry, which the callers' try/catch
 * blocks already handle as a silent-skip.
 */
const GH_TIMEOUT_MS = 5_000;

/**
 * Parse a git remote URL into `{ owner, repo }` when it points at GitHub.
 * Returns `null` for any non-GitHub URL (other forge, local path, malformed)
 * so the caller silently skips rather than failing init. Strips a trailing
 * `.git` if present.
 */
export function parseGitHubRemote(remoteUrl: string): GhRepoRef | null {
  const normalized = remoteUrl.trim().replace(/\/$/, '');
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(normalized);
  if (m === null) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Check `gh` CLI availability and auth status in one call. Returns null on
 * success or a structured reason string. `gh auth status` exits 0 when the
 * user is authed against github.com and non-zero otherwise; ENOENT signals
 * the binary itself is missing.
 */
export function ghAuthStatus(run: SpawnSyncFn = execFileSync): GhUnavailableReason | null {
  try {
    run('gh', ['auth', 'status'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: GH_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') return 'gh-not-installed';
    return 'gh-not-authed';
  }
}

/**
 * Fetch the `isPrivate` flag for a repo. Throws on subprocess or JSON
 * failure; callers wrap with try/catch and treat as silent-skip.
 */
export function isRepoPrivate(ref: GhRepoRef, run: SpawnSyncFn = execFileSync): boolean {
  const out = run('gh', ['repo', 'view', `${ref.owner}/${ref.repo}`, '--json', 'isPrivate'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GH_TIMEOUT_MS,
  }).toString();
  const parsed = JSON.parse(out) as { isPrivate?: unknown };
  return parsed.isPrivate === true;
}

/**
 * Fetch the `enabled` field of the repo's Actions permissions. Throws on
 * subprocess failure; callers wrap with try/catch.
 */
export function isActionsEnabled(ref: GhRepoRef, run: SpawnSyncFn = execFileSync): boolean {
  const out = run(
    'gh',
    ['api', `repos/${ref.owner}/${ref.repo}/actions/permissions`, '--jq', '.enabled'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: GH_TIMEOUT_MS },
  )
    .toString()
    .trim();
  return out === 'true';
}

/**
 * Disable GitHub Actions on a repo. Idempotent on GitHub's side: re-disabling
 * an already-disabled repo returns success. Throws on subprocess failure.
 */
export function disableActions(ref: GhRepoRef, run: SpawnSyncFn = execFileSync): void {
  run(
    'gh',
    [
      'api',
      '-X',
      'PUT',
      `repos/${ref.owner}/${ref.repo}/actions/permissions`,
      '-F',
      'enabled=false',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: GH_TIMEOUT_MS },
  );
}

/**
 * Read the `origin` remote URL for a git working tree at `cwd`. Throws on
 * any failure (no remote, not a git repo); callers treat as silent-skip.
 */
export function readOriginRemote(cwd: string, run: SpawnSyncFn = execFileSync): string {
  return run('git', ['remote', 'get-url', 'origin'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}
