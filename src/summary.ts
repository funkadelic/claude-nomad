import { ok, warn } from './utils.ts';

/**
 * Emit the single end-of-run summary line shared by cmdPull, cmdPush, and
 * cmdDiff. Canonical phrasing:
 *   - `summary: clean` when nothing was unmapped (and, for push, no
 *     collisions or extras skipped). Always printed so users see a consistent
 *     terminator and can spot when behavior changes.
 *   - `summary: <N> unmapped on pull (run nomad doctor to list)`
 *   - `summary: <N> unmapped on pull, <X> extras skipped (run nomad doctor to list)`
 *   - `summary: <N> unmapped on diff (run nomad doctor to list)`
 *   - `summary: <N> unmapped on push, <M> collisions (run nomad doctor to list)`
 *   - `summary: <N> unmapped on push, <M> collisions, <X> extras skipped (run nomad doctor to list)`
 *
 * Clean outcomes go through `ok()` (green `✓` glyph, stdout) and unmapped /
 * collision / extras-skipped outcomes go through `warn()` (yellow `⚠︎` glyph,
 * stderr). The status glyph carries the success/warn semantics; users see e.g.
 * `✓ summary: clean` or `⚠︎ summary: 3 unmapped on pull (...)`. Note: clean
 * still goes to stdout so it survives backgrounded shell-rc invocations
 * like `nomad pull 2>/dev/null &`. `collisions` is meaningful only for
 * `'push'`; for `'pull'` / `'diff'` it is ignored and defaults to 0.
 * `extrasSkipped` counts dirnames that the per-project whitelist
 * (`SUPPORTED_EXTRAS`) declined to sync; surfaces from `remapExtrasPush`
 * and `remapExtrasPull`. The fourth positional parameter defaults to 0 so
 * legacy three-arg call sites continue to work unchanged (D-03 additive
 * contract). This module is the SINGLE source of truth for the phrasing,
 * eliminating drift risk across the three callers by construction.
 */
export function emitSummary(
  verb: 'pull' | 'push' | 'diff',
  unmapped: number,
  collisions = 0,
  extrasSkipped = 0,
): void {
  if (verb === 'push') {
    if (unmapped === 0 && collisions === 0 && extrasSkipped === 0) {
      ok('summary: clean');
      return;
    }
    const base = `summary: ${unmapped} unmapped on push, ${collisions} collisions`;
    const extras = extrasSkipped > 0 ? `, ${extrasSkipped} extras skipped` : '';
    warn(`${base}${extras} (run nomad doctor to list)`);
    return;
  }
  if (unmapped === 0 && extrasSkipped === 0) {
    ok('summary: clean');
    return;
  }
  const extras = extrasSkipped > 0 ? `, ${extrasSkipped} extras skipped` : '';
  warn(`summary: ${unmapped} unmapped on ${verb}${extras} (run nomad doctor to list)`);
}
