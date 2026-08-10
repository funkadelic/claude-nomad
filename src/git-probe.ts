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
 * Ceiling on a single probe's stdout. Node's default is 1 MB, which a listing
 * probe can legitimately exceed (`ls-files --others` over a large shared tree is
 * one path per line), and exceeding it throws ENOBUFS. That failure reaches the
 * caller as an ordinary `null`, indistinguishable from "git could not answer",
 * so the feature the probe feeds turns itself off on exactly the hosts with the
 * most to sync and says nothing. Sized well past any real listing instead, since
 * the output is transient and freed as soon as the caller has filtered it.
 */
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a `git <args>` in `repo` and return its stdout.
 *
 * Read-only for most callers, but not read-only by contract: it is also the
 * codebase's only never-throwing git invoker, so a fail-open revert step that
 * must not be able to fail a command (`git checkout HEAD -- <path>` in the
 * pull's denylist backstop) runs through here too.
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
      maxBuffer: PROBE_MAX_BUFFER,
    }).toString();
  } catch {
    return null;
  }
}
