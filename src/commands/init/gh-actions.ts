import { execFileSync } from 'node:child_process';
import type { SpawnSyncFn } from '../../core/spawn-sync.ts';

/**
 * GitHub repo owner/name pair parsed from a remote URL. Used by
 * `cmdInit`'s auto-disable hook and `nomad doctor`'s Actions-drift check.
 */
export type GhRepoRef = { owner: string; repo: string };

/**
 * Reason `ghAuthStatus` returned without success. Distinguishes three
 * actionable failure modes so callers decide how to treat each:
 * `gh-not-installed` (the binary is missing), `gh-not-authed` (gh ran and
 * reported no authentication), and `gh-probe-error` (the probe itself failed,
 * e.g. a timeout or transient spawn error, so the auth state is unknown).
 */
export type GhUnavailableReason = 'gh-not-installed' | 'gh-not-authed' | 'gh-probe-error';

/**
 * Maximum time in milliseconds to wait for a `gh` CLI subprocess. Prevents
 * `nomad init` from hanging indefinitely on a slow or captive-portal network;
 * `execFileSync` throws `ETIMEDOUT` on expiry, which the callers' try/catch
 * blocks already handle as a silent-skip.
 */
const GH_TIMEOUT_MS = 5_000;

/** Hosts that serve GitHub repositories over git (web, and SSH over port 443). */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/** URL schemes git accepts for a remote, as `URL.protocol` reports them. */
const GIT_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);

/** `owner/repo` path in GitHub's allowed characters, optional `.git` and trailing slash. */
const OWNER_REPO = /^\/?([a-z0-9-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** scp-style remote, `[user@]host:path`, split at the first colon as git does. */
const SCP_REMOTE = /^(?:[\w.-]+@)?([^:/@\\]+):(.+)$/;

/**
 * Split a remote into host and repo path. URL forms go through the WHATWG
 * parser, so `#`, `?` and `\\` tricks resolve to the host git would contact.
 */
function splitRemote(remote: string): { host: string; path: string } | null {
  if (!remote.includes('://')) {
    const m = SCP_REMOTE.exec(remote);
    return m === null ? null : { host: m[1], path: m[2] };
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (!GIT_SCHEMES.has(url.protocol) || url.search !== '' || url.hash !== '') return null;
  return { host: url.hostname, path: url.pathname };
}

/**
 * Parse a git remote URL into `{ owner, repo }` when it points at GitHub.
 * Returns `null` for any non-GitHub URL (other forge, local path, malformed)
 * so the caller silently skips rather than failing init. Strips a trailing
 * `.git` if present. Only the real host counts, so `github.com` appearing in
 * the path, query, fragment or userinfo does not match.
 */
export function parseGitHubRemote(remoteUrl: string): GhRepoRef | null {
  const parts = splitRemote(remoteUrl.trim());
  if (parts === null || !GITHUB_HOSTS.has(parts.host.toLowerCase())) return null;
  const m = OWNER_REPO.exec(parts.path);
  if (m === null) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Check `gh` CLI availability and auth status in one call. Returns null on
 * success or a structured reason string. `gh auth status` exits 0 when the
 * user is authed against github.com and non-zero otherwise.
 *
 * The catch separates a definitive answer from an indeterminate one so callers
 * are not forced to treat a transient probe failure as "not authed":
 * - `ENOENT`: the binary is missing, so `gh-not-installed`.
 * - the child ran and exited with a numeric code (`typeof status === 'number'`,
 *   which by spawnSync semantics means it was not signal-killed): the only
 *   definitive unauthenticated answer, so `gh-not-authed`.
 * - anything else (a timeout SIGTERM-kills the child so `status` is null, an
 *   `ETIMEDOUT`, a spawn hiccup): the probe itself failed, so `gh-probe-error`.
 */
export function ghAuthStatus(run: SpawnSyncFn = execFileSync): GhUnavailableReason | null {
  try {
    run('gh', ['auth', 'status'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: GH_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    const e = err as { code?: string; status?: number | null };
    if (e.code === 'ENOENT') return 'gh-not-installed';
    if (typeof e.status === 'number') return 'gh-not-authed';
    return 'gh-probe-error';
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
