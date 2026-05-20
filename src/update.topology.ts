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

/** Escape regex metacharacters so a config value with `.` or `+` interpolated
 * into a `new RegExp(...)` does not silently broaden the match. The current
 * slug has no metachars, but this keeps the call defensible if it changes. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Strict patterns matching the public repo's SSH and HTTPS remote URL forms,
 * with and without a `.git` suffix. Both `git remote add upstream ...` styles
 * (set-url ssh, gh-clone https) must round-trip through `detectTopology`.
 */
const SLUG_RE = escapeRe(UPSTREAM_REPO_SLUG);
const SSH_REGEX = new RegExp(String.raw`^git@github\.com:${SLUG_RE}(\.git)?$`);
const HTTPS_REGEX = new RegExp(String.raw`^https://github\.com/${SLUG_RE}(\.git)?$`);

/**
 * Determines whether a remote URL matches the canonical upstream repository forms (SSH or HTTPS).
 *
 * @param url - The remote URL to test
 * @returns `true` if `url` matches the canonical upstream SSH or HTTPS form, `false` otherwise.
 */
function matchesUpstream(url: string): boolean {
  return SSH_REGEX.test(url) || HTTPS_REGEX.test(url);
}

/**
 * Parse the output of `git remote -v` into a mapping of remote names to their fetch URLs.
 *
 * Ignores `(push)` entries because topology detection drives the
 * `git pull`/`fetch`/`merge` invocations, which all use the fetch URL.
 * Lines that do not match the expected `<name> <url> (fetch)` format are
 * skipped.
 *
 * @param out - Raw stdout from `git remote -v`
 * @returns A record mapping each remote name to its fetch URL
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
 * Classify a parsed `{ name: fetchUrl }` remote map into a topology label.
 *
 * Classification rules:
 * - `vanilla` — exactly one remote named `origin` matching the public repo.
 * - `fork` — an `upstream` matching the public repo and a separate `origin`
 *   (any URL).
 * - `unknown` — anything else (no `upstream`, an `origin` that does not
 *   match the public repo, etc.).
 *
 * Pure and side-effect-free; tests drive it directly with hand-built maps.
 *
 * @param remotes - Map of remote name -> fetch URL produced by `parseRemotes`.
 * @returns The resolved `Topology` label.
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
 * Detect the repository remote topology by running `git remote -v` in REPO_HOME
 * and routing the output through `parseRemotes` + `detectTopology`.
 *
 * `git remote -v` is read-only so failures here are unexpected; we still
 * route through `NomadFatal` so the dispatcher prints `[nomad] FATAL: ...`
 * rather than dumping a stack trace.
 *
 * @returns The detected topology label: `'vanilla'`, `'fork'`, or `'unknown'`.
 * @throws NomadFatal when `git remote -v` fails; any captured git stderr is written to `process.stderr` before the error is thrown.
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
