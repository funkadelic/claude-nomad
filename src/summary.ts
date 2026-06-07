import { ok, warn } from './utils.ts';

/** The three originating commands that share the end-of-run summary line. */
type SummaryVerb = 'pull' | 'push' | 'diff';

/**
 * Pure phrasing core for the end-of-run summary line shared by cmdPull,
 * cmdPush, and cmdDiff. Returns the message `text` (without any status glyph)
 * plus a `clean` flag so callers can pick the right glyph/stream. Canonical
 * phrasing:
 *   - `summary: clean` when nothing was unmapped (and, for push, no
 *     collisions or extras skipped).
 *   - `summary: <N> unmapped on pull (run nomad doctor to list)`
 *   - `summary: <N> unmapped on pull, <X> extras skipped (run nomad doctor to list)`
 *   - `summary: <N> unmapped on diff (run nomad doctor to list)`
 *   - `summary: <N> unmapped on push, <M> collisions (run nomad doctor to list)`
 *   - `summary: <N> unmapped on push, <M> collisions, <X> extras skipped (run nomad doctor to list)`
 *
 * `collisions` is meaningful only for `'push'`; for `'pull'` / `'diff'` it is
 * ignored and defaults to 0. `extrasSkipped` counts dirnames that the
 * per-project whitelist (`SUPPORTED_EXTRAS`) declined to sync. This function is
 * the SINGLE source of truth for the phrasing, so `emitSummary` (standalone
 * line) and `summaryRow` (tree row) cannot drift apart.
 *
 * @param verb - the originating command.
 * @param unmapped - count of path-map entries skipped for this host.
 * @param collisions - push-only collision count (ignored for pull/diff).
 * @param extrasSkipped - count of extras dirnames the whitelist declined.
 * @returns `{ text, clean }` where `clean` is true on the no-warning outcome.
 */
export function summaryText(
  verb: SummaryVerb,
  unmapped: number,
  collisions = 0,
  extrasSkipped = 0,
): { text: string; clean: boolean } {
  const extras = extrasSkipped > 0 ? `, ${extrasSkipped} extras skipped` : '';
  if (verb === 'push') {
    if (unmapped === 0 && collisions === 0 && extrasSkipped === 0) {
      return { text: 'summary: clean', clean: true };
    }
    const base = `summary: ${unmapped} unmapped on push, ${collisions} collisions`;
    return { text: `${base}${extras} (run nomad doctor to list)`, clean: false };
  }
  if (unmapped === 0 && extrasSkipped === 0) {
    return { text: 'summary: clean', clean: true };
  }
  return {
    text: `summary: ${unmapped} unmapped on ${verb}${extras} (run nomad doctor to list)`,
    clean: false,
  };
}

/**
 * Build the Summary-section row for the grouped push/pull/diff tree. Delegates
 * phrasing to `summaryText` so the row text matches `emitSummary`, then returns
 * the plain message text: no status glyph (the Summary group header carries the
 * success/warn semantics the inline glyph used to duplicate) and no color. The
 * constant "summary: " prefix is stripped, since the group header already reads
 * "Summary". A clean outcome renders as `clean`; any warning outcome renders as
 * its bare message, e.g. `3 unmapped on pull (run nomad doctor to list)`.
 *
 * @param verb - the originating command.
 * @param unmapped - count of path-map entries skipped for this host.
 * @param collisions - push-only collision count (ignored for pull/diff).
 * @param extrasSkipped - count of extras dirnames the whitelist declined.
 * @returns the plain row string for the Summary section.
 */
export function summaryRow(
  verb: SummaryVerb,
  unmapped: number,
  collisions = 0,
  extrasSkipped = 0,
): string {
  const { text } = summaryText(verb, unmapped, collisions, extrasSkipped);
  return text.replace(/^summary: /, '');
}

/**
 * Emit the single end-of-run summary line shared by cmdPull, cmdPush, and
 * cmdDiff. Delegates phrasing to `summaryText` so the wording cannot drift from
 * `summaryRow`. Clean outcomes go through `ok()` (green `✓` glyph, stdout) and
 * unmapped / collision / extras-skipped outcomes go through `warn()` (yellow
 * `⚠︎` glyph, stderr). The status glyph carries the success/warn semantics;
 * users see e.g. `✓ summary: clean` or `⚠︎ summary: 3 unmapped on pull (...)`.
 * Clean still goes to stdout so it survives backgrounded shell-rc invocations
 * like `nomad pull 2>/dev/null &`. The fourth positional parameter defaults to
 * 0 so legacy three-arg call sites continue to work unchanged (D-03 additive
 * contract). `cmdDiff` still calls this for its standalone summary line.
 */
export function emitSummary(
  verb: SummaryVerb,
  unmapped: number,
  collisions = 0,
  extrasSkipped = 0,
): void {
  const { text, clean } = summaryText(verb, unmapped, collisions, extrasSkipped);
  if (clean) {
    ok(text);
    return;
  }
  warn(text);
}
