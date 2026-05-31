import { execFileSync } from 'node:child_process';

import type { SpawnSyncFn } from './gh-actions.ts';

/**
 * Shared transport-only HTTP fetcher for `nomad doctor`. Tries curl first,
 * falls back to wget, returns the response body as a string. Returns `null`
 * when both binaries fail (offline, binary absent, non-2xx). Each binary is
 * given a 3s timeout. Callers keep their own JSON parsing and validation; this
 * helper is transport-only and never inspects the body content.
 */

/**
 * Fetch the body at `url` using curl (first) then wget (fallback). Returns the
 * response body string when either binary succeeds, or `null` when both fail
 * (either binary absent from PATH, a non-2xx response, a timeout, or any other
 * error). curl is tried with `-fsSL -m 3`; wget with `-qO- --timeout=3
 * --tries=1`. Both invocations use an argv array (no shell string) and a 3s
 * timeout. The url is passed verbatim to whichever binary runs.
 *
 * @param url - The URL to fetch.
 * @param run - Injectable subprocess runner for testing; defaults to execFileSync.
 * @returns The response body string, or `null` on any failure.
 */
export function fetchUrl(url: string, run: SpawnSyncFn = execFileSync): string | null {
  try {
    return run('curl', ['-fsSL', '-m', '3', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch {
    // curl failed (ENOENT, non-2xx, timeout, etc.) -- try wget fallback.
    // NOTE: execFileSync('wget', ...) is a Sonar S4036 PATH/exec hotspot.
    // This is accepted-risk: single-user CLI wrapping the user's own binary,
    // fixed argv array, hardcoded-by-caller url, no shell string, no
    // user-controlled input. Mark Safe in SonarCloud the same way the
    // existing curl call is. Never pin an absolute path.
    try {
      return run('wget', ['-qO-', '--timeout=3', '--tries=1', url], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch {
      return null;
    }
  }
}
