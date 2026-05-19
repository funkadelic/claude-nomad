import { log } from './utils.ts';

/**
 * Emit the single end-of-run summary line shared by cmdPull, cmdPush, and
 * cmdDiff. Canonical phrasing:
 *   - `summary: clean` when nothing was unmapped (and, for push, no
 *     collisions). Always printed so users see a consistent terminator
 *     and can spot when behavior changes.
 *   - `summary: <N> unmapped on pull (run nomad doctor to list)`
 *   - `summary: <N> unmapped on diff (run nomad doctor to list)`
 *   - `summary: <N> unmapped on push, <M> collisions (run nomad doctor to list)`
 *
 * `log()` already prepends `[nomad] `, so users see `[nomad] summary: ...`.
 * Goes to stdout (not stderr) so it survives backgrounded shell-rc
 * invocations like `nomad pull 2>/dev/null &`. `collisions` is meaningful
 * only for `'push'`; for `'pull'` / `'diff'` it is ignored and defaults to 0.
 * This module is the SINGLE source of truth for the phrasing, eliminating
 * drift risk across the three callers by construction.
 */
export function emitSummary(
  verb: 'pull' | 'push' | 'diff',
  unmapped: number,
  collisions = 0,
): void {
  if (verb === 'push') {
    if (unmapped === 0 && collisions === 0) {
      log('summary: clean');
      return;
    }
    log(
      `summary: ${unmapped} unmapped on push, ${collisions} collisions (run nomad doctor to list)`,
    );
    return;
  }
  if (unmapped === 0) {
    log('summary: clean');
    return;
  }
  log(`summary: ${unmapped} unmapped on ${verb} (run nomad doctor to list)`);
}
