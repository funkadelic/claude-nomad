import { execFileSync } from 'node:child_process';

import { REPO_HOME, UPSTREAM_REPO_SLUG } from './config.ts';
import { NomadFatal } from './utils.ts';

/**
 * Topology label resolved by `detectTopology`. `vanilla` is a single `origin`
 * remote pointing at the public repo (read-only consumer). `fork` is the
 * private-config layout: `upstream` is the public repo and `origin` is the
 * user's private mirror. `unknown` is anything else: no `upstream`, an
 * `origin` that does not match the public repo, etc. Unknown topologies
 * surface a fatal so the user can run the two-command manual fallback
 * without nomad guessing at intent.
 */
export type Topology = 'vanilla' | 'fork' | 'unknown';

/**
 * Strict patterns matching the public repo's SSH and HTTPS remote URL forms,
 * with and without a `.git` suffix. Both `git remote add upstream ...` styles
 * (set-url ssh, gh-clone https) must round-trip through `detectTopology`.
 */
const SSH_REGEX = new RegExp(`^git@github\\.com:${UPSTREAM_REPO_SLUG}(\\.git)?$`);
const HTTPS_REGEX = new RegExp(`^https://github\\.com/${UPSTREAM_REPO_SLUG}(\\.git)?$`);

/** True when `url` matches one of the canonical upstream URL forms. */
function matchesUpstream(url: string): boolean {
  return SSH_REGEX.test(url) || HTTPS_REGEX.test(url);
}

/**
 * Parse `git remote -v` output into a `{ name: fetchUrl }` map. Only the
 * `(fetch)` line per remote is retained; `(push)` URLs are ignored because
 * topology detection drives the `git pull/fetch/merge` invocations which all
 * use the fetch URL.
 */
export function parseRemotes(out: string): Record<string, string> {
  const remotes: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(trimmed);
    if (match === null) continue;
    remotes[match[1]] = match[2];
  }
  return remotes;
}

/**
 * Classify a parsed `{ name: fetchUrl }` remote map. Vanilla = exactly one
 * remote named `origin` matching the public repo. Fork = an `upstream`
 * matching the public repo and a separate `origin` (any URL). Anything else
 * is `unknown`. Pure, side-effect-free; tests drive it directly with
 * hand-built maps.
 */
export function detectTopology(remotes: Record<string, string>): Topology {
  const origin = remotes.origin;
  const upstream = remotes.upstream;
  if (typeof upstream === 'string' && matchesUpstream(upstream) && typeof origin === 'string') {
    return 'fork';
  }
  const names = Object.keys(remotes);
  if (names.length === 1 && names[0] === 'origin' && matchesUpstream(origin ?? '')) {
    return 'vanilla';
  }
  return 'unknown';
}

/**
 * Read `git remote -v` from REPO_HOME and route the output through
 * `parseRemotes` + `detectTopology`. Returns the resolved topology label.
 * `git remote -v` is read-only so failures here are unexpected; we still
 * route through `NomadFatal` so the dispatcher prints `[nomad] FATAL: ...`
 * rather than dumping a stack trace.
 */
export function loadTopology(): Topology {
  let out: string;
  try {
    out = execFileSync('git', ['remote', '-v'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal('git remote -v failed');
  }
  return detectTopology(parseRemotes(out));
}
