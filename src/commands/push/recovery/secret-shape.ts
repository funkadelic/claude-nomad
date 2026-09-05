/**
 * Describes a gitleaks finding's secret without ever printing it: character
 * class and length, a length-gated head/tail fragment, and the label text that
 * precedes the secret with every other finding's span blanked out.
 *
 * Split from `commands/push/recovery/display.ts`, which now owns only prompt
 * and block assembly. Depends on the `Finding` shape and on
 * `commands/push/recovery/span-align.ts` for the byte arithmetic, so the
 * dependency runs display -> this module -> span-align, never the reverse.
 */

import type { Finding } from '../gitleaks.scan.ts';
import { REDACTED_TOKEN, alignFindingSpan, type AlignedSpan } from './span-align.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Leading characters of the secret shown in the value fragment. */
const VALUE_HEAD = 4;

/** Trailing characters of the secret shown in the value fragment. */
const VALUE_TAIL = 4;

/** Minimum secret length before any fragment is shown; shorter secrets show the structural summary only. */
const MIN_ELIDE_LEN = 16;

/** Non-class separator between the head and tail fragments. */
const FRAGMENT_SEP = '...';

/** Maximum characters of label context shown on the `near:` line. */
const NEAR_WINDOW = 40;

/** Fragment column width when a structural summary follows on the value line. */
const VALUE_PAD = 16;

/**
 * Bytes of headroom added on both sides of a sibling's reported range when it
 * will not align. Covers the gitleaks column error in either direction, so no
 * byte of the sibling secret survives masking.
 */
const SIBLING_PAD = 2;

/** Control-character regex: C0 range (U+0000-U+001F) and DEL (U+007F). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// ---------------------------------------------------------------------------
// Secret classification and description
// ---------------------------------------------------------------------------

/**
 * Classify a secret's character set for the `value:` structural summary.
 * Each earlier class is a subset of the next, so evaluation order is the
 * definition: a hex string is also alphanumeric and base64url, but is
 * reported as the narrowest matching class.
 *
 * @param value The secret text to classify.
 * @returns One of `'hex'`, `'alphanumeric'`, `'base64url'`, or `'mixed'`.
 */
export function classifyCharset(value: string): string {
  if (/^[0-9a-fA-F]+$/.test(value)) return 'hex';
  if (/^[0-9a-zA-Z]+$/.test(value)) return 'alphanumeric';
  if (/^[0-9a-zA-Z_-]+$/.test(value)) return 'base64url';
  return 'mixed';
}

/**
 * Describe a secret for the `value:` line: a length-gated head/tail fragment
 * (below `MIN_ELIDE_LEN` chars, no fragment at all) plus a structural summary
 * (char count, char class, and entropy when supplied and greater than zero).
 * Never returns the secret itself, only a fragment short enough that it
 * cannot itself trip a high-entropy gitleaks rule when it lands in a
 * re-scanned session transcript.
 *
 * @param secret The real secret value (never rendered in full).
 * @param entropy The gitleaks-reported entropy for the finding, when available.
 * @returns The rendered `value:` line body.
 */
export function describeSecret(secret: string, entropy?: number): string {
  const parts = [`${secret.length} chars`, classifyCharset(secret)];
  if (typeof entropy === 'number' && Number.isFinite(entropy) && entropy > 0) {
    parts.push(`entropy ${entropy.toFixed(2)}`);
  }
  const summary = parts.join(', ');
  if (secret.length < MIN_ELIDE_LEN) return summary;
  const fragment = secret.slice(0, VALUE_HEAD) + FRAGMENT_SEP + secret.slice(-VALUE_TAIL);
  return `${fragment.padEnd(VALUE_PAD)}  ${summary}`;
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/** Collapse an empty string to null; a non-empty string passes through unchanged. */
function emptyToNull(text: string): string | null {
  return text.length > 0 ? text : null;
}

/**
 * Backstop that truncates `near` at the first occurrence of the resolved
 * secret. `near` is *intended* to hold only the text preceding the secret,
 * but that property depends on the column arithmetic being right, and
 * gitleaks reports byte offsets while a JavaScript string slices UTF-16 code
 * units. A line carrying multi-byte text before the secret once pushed the
 * lead past the secret's own start and printed it verbatim. Slicing is now
 * byte-based, so this is defense in depth rather than the primary control:
 * it enforces the invariant on the value rather than trusting how it was
 * built.
 *
 * @param near The candidate label text preceding the secret.
 * @param value The resolved secret, when one was recovered.
 * @returns `near` truncated before any occurrence of `value`, or null when nothing remains.
 */
function withoutValue(near: string | null, value: string | null): string | null {
  if (near === null || value === null || value.length === 0) return near;
  const idx = near.indexOf(value);
  return idx < 0 ? near : emptyToNull(near.slice(0, idx));
}

/**
 * The label text the finding carries INSIDE its own redaction template, i.e.
 * the part of `Match` before the `REDACTED` hole. This is the `near:` fallback
 * whenever the span could not be verified against the line.
 *
 * It is deliberately NOT spliced onto the line-derived lead. When alignment
 * fails the reported column is untrustworthy, so the lead runs to the wrong
 * offset and overlaps the template text: joining the two doubled the character
 * at the seam (`ssecret`, `ccreate`) and printed it to the user. The template
 * text alone is self-consistent, contains no secret by construction, and needs
 * no column arithmetic to be correct.
 *
 * @param finding The finding whose `Match` may carry a redaction template.
 * @returns The label text preceding the secret, or null when there is none.
 */
function templateLead(finding: Finding): string | null {
  const idx = finding.Match.indexOf(REDACTED_TOKEN);
  return idx > 0 ? finding.Match.slice(0, idx) : null;
}

/**
 * Byte range to blank for one sibling finding. Runs the same alignment as the
 * finding under triage, because a sibling's reported columns carry the same
 * offset error: masking the reported range would leave the sibling secret's
 * first byte exposed on the label line. Falls back to the clamped reported
 * range when the sibling will not align, which masks approximately the right
 * bytes rather than none at all.
 *
 * When it will not align, the reported range is used PADDED on both sides,
 * because that range is exactly the one known to be off by a byte: masking it
 * verbatim would leave the sibling secret's first byte on the label line, which
 * is the hazard this function exists to close. The padding costs a couple of
 * bytes of neighbouring label text, which the prompt does not need. A sibling
 * reporting no span at all is left alone rather than padded into one.
 *
 * @param sibling The other finding sharing this line.
 * @param buf The raw source line as UTF-8 bytes.
 * @returns The 0-indexed byte range to blank, `end` exclusive.
 */
function siblingBounds(sibling: Finding, buf: Buffer): { start: number; end: number } {
  const aligned = alignFindingSpan(sibling, buf);
  if (aligned !== null) return { start: aligned.start, end: aligned.end };
  const reportedStart = sibling.StartColumn - 1;
  if (sibling.EndColumn <= reportedStart) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(reportedStart, buf.length) - SIBLING_PAD);
  return { start, end: Math.max(start, Math.min(sibling.EndColumn + SIBLING_PAD, buf.length)) };
}

/**
 * Blank the byte spans of OTHER findings on the same line.
 *
 * When two secrets share a line, the second finding's label context is
 * everything before it, which includes the first secret. This is the exact
 * control for that. It masks by POSITION, not by value: replacing every
 * occurrence of a sibling's text would corrupt unrelated label characters
 * whenever that text is short (a one-character span once turned `label:`
 * into a run of ellipses), and shape heuristics cannot tell a hyphenated
 * label from a hyphenated passphrase.
 *
 * Filling with NUL keeps every byte offset stable, so the caller's own span
 * arithmetic is unaffected, and `CONTROL_CHARS` strips the fill during
 * rendering. A sibling overlapping the finding's own span is skipped so it
 * can never blank the value being described.
 *
 * @param buf The raw source line as UTF-8 bytes.
 * @param siblings Other findings sharing this finding's file and line.
 * @param ownStart 0-indexed byte offset where the finding's own span starts.
 * @param ownEnd Exclusive 0-indexed byte offset where the finding's own span ends.
 * @returns A copy with each sibling span blanked, or `buf` when there are none.
 */
function maskSiblingSpans(
  buf: Buffer,
  siblings: Finding[],
  ownStart: number,
  ownEnd: number,
): Buffer {
  if (siblings.length === 0) return buf;
  const copy = Buffer.from(buf);
  for (const sibling of siblings) {
    const { start, end } = siblingBounds(sibling, buf);
    // Mask everything outside the finding's own span. Skipping an overlapping
    // sibling wholesale used to leave its protruding head in the label: two
    // rules can match nested spans on one line, so a broad rule enclosing a
    // narrow one starts to the LEFT of ownStart and that prefix reached the
    // rendered output. The own span itself is never blanked.
    const headEnd = Math.min(end, ownStart);
    if (start < headEnd) copy.fill(0, start, headEnd);
    const tailStart = Math.max(start, ownEnd);
    if (tailStart < end) copy.fill(0, tailStart, end);
  }
  return copy;
}

/**
 * Recover a display-safe description of a finding's secret and its
 * immediately preceding label text, without ever exposing the secret itself
 * in `near`. The span is recovered by `alignFindingSpan`, which verifies the
 * reported columns against the line rather than trusting them; when nothing
 * verifies, `value` is null and `near` falls back to the finding's own
 * redaction-template text.
 *
 * @param finding The gitleaks finding to resolve.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @returns `{ value, near }`, both `string | null`.
 */
export function resolveSecretContext(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
  siblings: Finding[] = [],
): { value: string | null; near: string | null; exact: boolean } {
  const resolved = resolveSpanContext(finding, readLine, siblings);
  // A multi-line match needs no special case here: `alignFindingSpan` declines
  // it outright rather than describing a fragment of a PEM block as if it were
  // the whole key, so a resolved value is always wholly on this line.
  return {
    value: resolved.value,
    near: withoutValue(resolved.near, resolved.value),
    exact: resolved.exact,
  };
}

/**
 * Resolve a finding whose source line could not be read (missing file,
 * out-of-range line, or a path the reader refused). Nothing here touches the
 * reported columns, so none of it can be shifted.
 *
 * A `Match` carrying the redaction token has had its secret replaced by a
 * placeholder, so there is no value left to describe and only the template's
 * label text is offered. An unredacted `Match` IS the matched text, quoted
 * verbatim by gitleaks, so it can still be described; `exact` stays false
 * because the secret is only a part of it and the reported entropy would
 * describe something narrower than what is shown.
 *
 * @param finding The gitleaks finding to resolve.
 * @returns `{ value, near }`, both `string | null`.
 */
function resolveWithoutLine(finding: Finding): {
  value: string | null;
  near: string | null;
  exact: boolean;
} {
  if (finding.Match.includes(REDACTED_TOKEN)) {
    return { value: null, near: templateLead(finding), exact: false };
  }
  return { value: emptyToNull(finding.Match), near: null, exact: false };
}

/**
 * Resolve the raw `{ value, near }` pair before the `withoutValue` backstop
 * is applied. Split out so `resolveSecretContext` stays a short guard and this
 * body stays under the cognitive-complexity gate.
 *
 * All arithmetic is BYTE-based, because gitleaks reports its columns as byte
 * offsets: slicing the line as a JavaScript string (UTF-16 code units)
 * misaligns the span on any line carrying multi-byte UTF-8 before the secret,
 * which session transcripts routinely do. `alignFindingSpan` owns the offsets
 * themselves, including the correction for gitleaks reporting them one high
 * after the first line of a file.
 *
 * `near` is the masked line text up to the START OF THE VALUE, so the label
 * text inside a redaction template is included while the secret never is.
 *
 * @param finding The gitleaks finding to resolve.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @param siblings Other findings sharing this finding's file and line.
 * @returns `{ value, near }`, both `string | null`.
 */
function resolveSpanContext(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
  siblings: Finding[] = [],
): { value: string | null; near: string | null; exact: boolean } {
  const raw = readLine(finding.File, finding.StartLine);
  if (raw === null) return resolveWithoutLine(finding);
  const unresolved = { value: null, near: templateLead(finding), exact: false };
  const buf = Buffer.from(raw, 'utf8');
  const aligned: AlignedSpan | null = alignFindingSpan(finding, buf);
  if (aligned === null) return unresolved;
  const near = maskSiblingSpans(buf, siblings, aligned.start, aligned.end)
    .subarray(0, aligned.valueStart)
    .toString('utf8');
  return { value: aligned.value, near: emptyToNull(near), exact: aligned.exact };
}

// ---------------------------------------------------------------------------
// near: rendering
// ---------------------------------------------------------------------------

/**
 * Format the `near:` line body: strips control characters, then keeps a
 * trailing window of at most `NEAR_WINDOW` characters (the label text
 * immediately adjacent to the secret is what matters), prefixing an ellipsis
 * when the text was truncated. `near` is constructed by `resolveSecretContext`
 * as strictly the text preceding the secret span, so it can never contain the
 * secret itself or anything after it.
 *
 * @param text The raw label text preceding the secret.
 * @returns The formatted `near:` line body, or null when nothing remains after stripping and trimming.
 */
export function formatNear(text: string): string | null {
  const stripped = elideTokenRuns(text.replace(CONTROL_CHARS, ''));
  const truncated = stripped.length > NEAR_WINDOW;
  const window = stripped.slice(-NEAR_WINDOW).trim();
  if (window.length === 0) return null;
  return (truncated ? FRAGMENT_SEP : '') + window;
}

/**
 * Elide token-shaped runs from label text before it is rendered.
 *
 * BEST EFFORT ONLY, and deliberately not the control for a neighbouring
 * secret: that is `maskSiblingSpans`, which blanks other findings' byte spans
 * by position. Shape cannot decide the question, because a hyphenated
 * label and a hyphenated passphrase are indistinguishable, and a short
 * secret is indistinguishable from a short word. This catches obvious
 * token-shaped junk that gitleaks did not flag, and nothing more. Text that
 * gitleaks did not report as a secret can still appear here.
 *
 * @param text The label text to sanitize.
 * @returns The text with token-shaped atoms replaced by an ellipsis.
 */
function elideTokenRuns(text: string): string {
  return text.replace(/[A-Za-z0-9_+=-]+/g, (atom) => {
    if (atom.length < MIN_ELIDE_LEN) return atom;
    if (/^[A-Za-z_-]+$/.test(atom)) return atom;
    return FRAGMENT_SEP;
  });
}
