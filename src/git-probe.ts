/**
 * Bounded, never-throwing git stdout capture for read-only probes.
 *
 * The pull's mirror-collision path asks git several read-only questions around
 * a failing `git pull`: which files under `shared/` are untracked, and whether
 * the fetched update adds a given path. Every one of them is advisory. A probe
 * that throws would turn a diagnostic into the thing that fails the command,
 * and a probe with no timeout would let a hung git binary block a pull that has
 * already finished its real work. Both properties are enforced here once rather
 * than re-derived at each call site.
 *
 * Deliberately NOT folded into `gitCaptureRaw`: that helper is unbounded and
 * propagates failures, which is correct for the callers that need the output to
 * proceed and wrong for a probe whose whole contract is to degrade quietly.
 *
 * Dependency-free leaf: zero project imports, so any module can use it without
 * risking a cycle.
 */

import { execFileSync } from 'node:child_process';

/**
 * Ceiling on a single probe call. Generous enough that a cold index read on a
 * large repo finishes, short enough that a wedged git binary cannot hold a pull
 * open indefinitely.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Run a read-only `git <args>` in `repo` and return its stdout.
 *
 * @param args - Git arguments (excludes the `git` binary name itself).
 * @param repo - Working directory for the invocation.
 * @returns The raw stdout string, or `null` when the call failed for any reason
 *   at all (git absent, non-zero exit, timeout, unreadable repo). Callers treat
 *   `null` as "cannot tell" and fall back to their pre-probe behavior; an empty
 *   string is a successful probe that produced no output and is NOT the same
 *   thing.
 */
export function gitProbe(args: readonly string[], repo: string): string | null {
  try {
    return execFileSync('git', args as string[], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    }).toString();
  } catch {
    return null;
  }
}
