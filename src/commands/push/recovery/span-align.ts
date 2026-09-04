/**
 * Recovers where a gitleaks finding's match REALLY sits on its source line.
 *
 * `gitleaks protect --staged` reports `StartColumn`/`EndColumn` one higher than
 * the true byte position for any finding whose `StartLine` is greater than 1,
 * so a span sliced at the reported column drops the secret's first character
 * and picks up a stray trailing one. The reported WIDTH
 * (`EndColumn - StartColumn + 1`) is unaffected, because both ends shift
 * together, and that is what makes the true span recoverable.
 *
 * The columns are therefore treated as a HINT: candidate spans are generated at
 * a small symmetric set of byte shifts around the reported start and filtered by
 * oracles that do not depend on the column arithmetic being right. A shift is
 * accepted only when it is the UNIQUE survivor, so an ambiguous line yields no
 * value rather than a guess. Nothing here encodes which direction gitleaks errs
 * in: `SHIFT_WINDOW` is symmetric and, because acceptance requires uniqueness
 * rather than first-match, order-independent.
 *
 * Dependency-free apart from the `Finding` shape, so it sits below
 * `commands/push/recovery/secret-shape.ts` with no cycle.
 */

import type { Finding } from '../gitleaks.scan.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Literal token gitleaks substitutes for a real secret when `--redact` is passed. */
export const REDACTED_TOKEN = 'REDACTED';

/**
 * Byte shifts applied to the reported start column when generating candidates.
 * Symmetric and two wide: the observed gitleaks error is a single byte, and one
 * byte of headroom either side covers a report that drifts further without
 * opening the window so far that unrelated text starts to verify.
 */
const SHIFT_WINDOW = [0, -1, 1, -2, 2];

/**
 * Agreement window for the entropy tiebreaker. gitleaks marshals `Entropy` as a
 * float32, so the reported decimal never matches a float64 recomputation
 * exactly; the gap between genuinely different candidates is orders of
 * magnitude larger than this window.
 */
const ENTROPY_TOLERANCE = 1e-4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A verified byte span for one finding on one line. All offsets are 0-indexed byte offsets. */
export type AlignedSpan = {
  /** Where the finding's whole match span starts. */
  start: number;
  /** Exclusive end of the match span. */
  end: number;
  /** Where the secret value starts, at or after `start` (a redaction template may carry a label prefix). */
  valueStart: number;
  /** The recovered value. */
  value: string;
  /**
   * True when `value` is the real secret, so `Finding.Entropy` describes it.
   * False when the report was unredacted and `value` is the whole match, of
   * which the secret is only a part.
   */
  exact: boolean;
};

/** The `Match` text bracketing the secret, split at the redaction token. */
type MatchTemplate = {
  /** Match text before the secret. */
  pre: string;
  /** Match text after the secret. */
  post: string;
  /** True when `Match` carried the redaction token, i.e. the secret is a hole inside it. */
  redacted: boolean;
};

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/**
 * Read one byte, returning undefined outside the buffer rather than relying on
 * out-of-range index semantics.
 *
 * @param buf The line bytes.
 * @param at 0-indexed byte offset.
 * @returns The byte, or undefined when `at` is outside the buffer.
 */
function byteAt(buf: Buffer, at: number): number | undefined {
  return at >= 0 && at < buf.length ? buf[at] : undefined;
}

/**
 * Whether a byte is a word character (`[A-Za-z0-9_]`), the character class
 * gitleaks rules treat as token interior.
 *
 * @param byte The byte to test, or undefined for a position outside the line.
 * @returns True for a word byte, false for anything else including undefined.
 */
function isWordByte(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f
  );
}

/**
 * Whether a span edge cuts a word-character run in half. A gitleaks rule
 * anchors its match on a token boundary, so an edge with word bytes on both
 * sides means the candidate is misaligned. This is the oracle that discriminates
 * shifts the redaction template cannot see, e.g. a bare `REDACTED` match where
 * the template is empty and every shift satisfies it vacuously.
 *
 * @param buf The line bytes.
 * @param at The span edge, as a 0-indexed byte offset.
 * @returns True when the edge splits a token.
 */
function splitsToken(buf: Buffer, at: number): boolean {
  return isWordByte(byteAt(buf, at - 1)) && isWordByte(byteAt(buf, at));
}

/**
 * Shannon entropy of a string, in bits per character, computed over UTF-16 code
 * points the same way gitleaks computes it over the secret it matched.
 *
 * @param text The text to measure.
 * @returns The entropy in bits, or 0 for an empty string.
 */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/**
 * Split a finding's `Match` into the text bracketing its secret. A `Match`
 * carrying the redaction token brackets a hole; one without it IS the match
 * text verbatim, which is a strong oracle in its own right. An empty `Match`
 * (a malformed report entry, defaulted by `toFinding`) offers nothing to verify
 * against.
 *
 * @param finding The finding whose `Match` to split.
 * @returns The template, or null when `Match` is empty.
 */
function matchTemplate(finding: Finding): MatchTemplate | null {
  if (finding.Match.length === 0) return null;
  const idx = finding.Match.indexOf(REDACTED_TOKEN);
  if (idx < 0) return { pre: '', post: '', redacted: false };
  return {
    pre: finding.Match.slice(0, idx),
    post: finding.Match.slice(idx + REDACTED_TOKEN.length),
    redacted: true,
  };
}

/**
 * Whether a candidate span is consistent with the finding's `Match`. An
 * unredacted `Match` must be reproduced exactly; a redacted one must bracket the
 * span, leaving room for a non-empty secret between its two halves.
 *
 * @param span The candidate span text.
 * @param finding The finding being aligned.
 * @param template The finding's split `Match`.
 * @returns True when the span is consistent with the template.
 */
function fitsTemplate(span: string, finding: Finding, template: MatchTemplate): boolean {
  if (!template.redacted) return span === finding.Match;
  return span.startsWith(template.pre) && span.endsWith(template.post);
}

/**
 * Build and verify the candidate span at one byte shift. Returns null when the
 * candidate falls outside the line, contradicts the `Match` template, leaves no
 * value between the template halves, or has an edge that splits a token.
 *
 * @param finding The finding being aligned.
 * @param buf The line bytes.
 * @param template The finding's split `Match`.
 * @param shift Byte shift applied to the reported start column.
 * @returns The verified span, or null when this shift does not hold up.
 */
function candidateAt(
  finding: Finding,
  buf: Buffer,
  template: MatchTemplate,
  shift: number,
): AlignedSpan | null {
  const start = finding.StartColumn - 1 + shift;
  const end = start + (finding.EndColumn - finding.StartColumn + 1);
  if (start < 0 || end > buf.length) return null;
  const span = buf.subarray(start, end).toString('utf8');
  if (!fitsTemplate(span, finding, template)) return null;
  const valueStart = start + Buffer.byteLength(template.pre, 'utf8');
  const valueEnd = end - Buffer.byteLength(template.post, 'utf8');
  const value = buf.subarray(valueStart, valueEnd).toString('utf8');
  if (value.length === 0) return null;
  if (splitsToken(buf, start) || splitsToken(buf, end)) return null;
  return { start, end, valueStart, value, exact: template.redacted };
}

/**
 * Locate `Finding.Secret` on the line directly. Available only on an unredacted
 * report (`scanFile`), where the literal value is known and finding it is proof
 * of alignment, so this short-circuits the shift search entirely. When the value
 * occurs more than once, the occurrence nearest the reported column wins.
 *
 * @param finding The finding being aligned.
 * @param buf The line bytes.
 * @returns The located span, or null when there is no usable `Secret`.
 */
function locateSecretLiteral(finding: Finding, buf: Buffer): AlignedSpan | null {
  const secret = finding.Secret;
  if (typeof secret !== 'string' || secret.length === 0 || secret === REDACTED_TOKEN) return null;
  const needle = Buffer.from(secret, 'utf8');
  const hint = finding.StartColumn - 1;
  let best: number | null = null;
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
    if (best === null || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
  }
  if (best === null) return null;
  return { start: best, end: best + needle.length, valueStart: best, value: secret, exact: true };
}

/**
 * Narrow an ambiguous candidate set using the gitleaks-reported entropy. Used
 * ONLY as a tiebreaker: it is too weak to gate the main path (a swap of two
 * characters each occurring once leaves entropy unchanged) and float32
 * round-tripping makes an equality test brittle. Declines whenever the reported
 * entropy cannot describe a candidate's value: no entropy in the report, or an
 * unredacted match whose value is wider than the secret.
 *
 * @param hits The candidates that survived the other oracles.
 * @param finding The finding being aligned.
 * @returns The single candidate whose value agrees with the reported entropy, or null.
 */
function breakTie(hits: AlignedSpan[], finding: Finding): AlignedSpan | null {
  const reported = finding.Entropy;
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) return null;
  const agreeing = hits.filter(
    (h) => h.exact && Math.abs(shannonEntropy(h.value) - reported) <= ENTROPY_TOLERANCE,
  );
  return agreeing.length === 1 ? agreeing[0] : null;
}

/**
 * Recover a finding's real byte span on its line, or null when it cannot be
 * verified. A null return is a deliberate outcome, not an error: the caller
 * renders no value and no line-derived context rather than text that may be off
 * by a character.
 *
 * @param finding The gitleaks finding to align.
 * @param buf The raw source line, as UTF-8 bytes.
 * @returns The verified span, or null when no single shift holds up.
 */
export function alignFindingSpan(finding: Finding, buf: Buffer): AlignedSpan | null {
  const literal = locateSecretLiteral(finding, buf);
  if (literal !== null) return literal;
  // A multi-line match reports EndColumn on its END line, so the reported width
  // describes neither this line's fragment nor the whole secret. A bare
  // `REDACTED` match has an empty template, which verifies vacuously, so an
  // arbitrary-width candidate could win uniquely and be described as if it were
  // the whole secret: the exact class of misreport this module exists to
  // prevent. Decline instead, and let the caller render location and rule only.
  if (typeof finding.EndLine === 'number' && finding.EndLine > finding.StartLine) return null;
  const template = matchTemplate(finding);
  if (template === null) return null;
  const hits: AlignedSpan[] = [];
  for (const shift of SHIFT_WINDOW) {
    const candidate = candidateAt(finding, buf, template, shift);
    if (candidate !== null) hits.push(candidate);
  }
  if (hits.length === 1) return hits[0];
  return breakTie(hits, finding);
}
