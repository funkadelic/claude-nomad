/**
 * Pure rendering helpers for the push-time recovery menu: describes a
 * gitleaks finding's secret span without ever printing the raw value.
 * Replaces the retired masking helpers formerly in
 * `commands.push.recovery.seams.ts`, which masked the wrong span (the
 * gitleaks match text) instead of describing the secret itself. Imports
 * `sessionIdFromFinding` from `./commands.push.recovery.seams.ts`; the
 * dependency runs this module -> seams, never the reverse.
 */

import type { Finding } from './push-gitleaks.scan.ts';
import { sessionIdFromFinding } from './commands.push.recovery.seams.ts';

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

/** Literal token gitleaks substitutes for a real secret when `--redact` is passed. */
const REDACTED_TOKEN = 'REDACTED';

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
 * Attempt to recover the secret by aligning the finding's (possibly redacted)
 * `Match` template against the raw source span. Returns null when `Match`
 * does not contain the `REDACTED` literal at all (the unredacted-report or
 * final-fallback paths in `resolveSecretContext` apply instead); otherwise
 * always returns a result, with `value: null` when alignment fails (no
 * readable line, or the raw span does not bracket a `REDACTED`-shaped hole).
 *
 * @param finding The gitleaks finding, whose `Match` may carry the literal `REDACTED`.
 * @param span The raw source span at the finding's column range, or `finding.Match` when no line was readable.
 * @param lead The raw source text preceding `span` on its line, or `''` when no line was readable.
 * @returns `{ value, near }` when `Match` contains `REDACTED`, else null.
 */
function alignRedactedMatch(
  finding: Finding,
  span: string,
  lead: string,
): { value: string | null; near: string | null } | null {
  const idx = finding.Match.indexOf(REDACTED_TOKEN);
  if (idx < 0) return null;
  const pre = finding.Match.slice(0, idx);
  const post = finding.Match.slice(idx + REDACTED_TOKEN.length);
  if (
    span !== finding.Match &&
    span.startsWith(pre) &&
    span.endsWith(post) &&
    span.length > pre.length + post.length
  ) {
    return {
      value: span.slice(pre.length, span.length - post.length),
      near: emptyToNull(lead + pre),
    };
  }
  return { value: null, near: emptyToNull(lead + pre) };
}

/**
 * Recover a display-safe description of a finding's secret and its
 * immediately preceding label text, without ever exposing the secret itself
 * in `near`. Tries, in order: redacted-template alignment (the push path's
 * usual shape, since `scanStagedTree` passes `--redact`), the unredacted
 * report's `Finding.Secret`, then a conservative fallback that treats the
 * whole clamped raw span as the secret.
 *
 * @param finding The gitleaks finding to resolve.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @returns `{ value, near }`, both `string | null`.
 */
export function resolveSecretContext(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
): { value: string | null; near: string | null } {
  const raw = readLine(finding.File, finding.StartLine);

  let span: string;
  let lead: string;
  if (raw !== null) {
    const len = raw.length;
    const startCol = Math.max(1, Math.min(finding.StartColumn, len + 1));
    const endCol = Math.max(startCol, Math.min(finding.EndColumn, len));
    span = raw.slice(startCol - 1, endCol);
    lead = raw.slice(0, startCol - 1);
  } else {
    span = finding.Match;
    lead = '';
  }

  const aligned = alignRedactedMatch(finding, span, lead);
  if (aligned !== null) return aligned;

  if (
    typeof finding.Secret === 'string' &&
    finding.Secret.length > 0 &&
    span.includes(finding.Secret)
  ) {
    return {
      value: finding.Secret,
      near: emptyToNull(lead + span.slice(0, span.lastIndexOf(finding.Secret))),
    };
  }

  return {
    value: span.length > 0 ? span : null,
    near: emptyToNull(lead),
  };
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
  const stripped = text.replace(CONTROL_CHARS, '');
  const truncated = stripped.length > NEAR_WINDOW;
  const window = stripped.slice(-NEAR_WINDOW).trim();
  if (window.length === 0) return null;
  return (truncated ? FRAGMENT_SEP : '') + window;
}

// ---------------------------------------------------------------------------
// Block assembly
// ---------------------------------------------------------------------------

/**
 * Build the ` (session: <sid>)` suffix for the `file:` line, or `''` when the
 * finding has no resolvable session id.
 *
 * @param finding The finding to check.
 * @returns The suffix text, or `''`.
 */
function sessionSuffix(finding: Finding): string {
  const sid = sessionIdFromFinding(finding);
  return sid === null ? '' : ` (session: ${sid})`;
}

/**
 * Render the body lines for one finding: the `file:` line (always present,
 * with the session suffix from `sessionSuffix`), then `value:` and `near:`
 * lines when `resolveSecretContext` produced a non-null value for each.
 *
 * @param finding The finding to render.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @returns The body lines, in order, omitting any whose source was null.
 */
export function renderFindingBlock(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
): string[] {
  const lines = [`  file:  ${finding.File}:${finding.StartLine}${sessionSuffix(finding)}`];
  const { value, near } = resolveSecretContext(finding, readLine);
  if (value !== null) lines.push(`  value: ${describeSecret(value, finding.Entropy)}`);
  const formattedNear = near !== null ? formatNear(near) : null;
  if (formattedNear !== null) lines.push(`  near:  ${formattedNear}`);
  return lines;
}
