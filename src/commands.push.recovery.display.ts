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
import { findingKey, sessionIdFromFinding } from './commands.push.recovery.seams.ts';

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

/** Rule id column width when an occurrence summary follows on the header line. */
const RULE_PAD = 24;

/** Separator joining the parts of a grouping key; never appears in a fingerprint or a secret. */
const GROUP_SEP = '\u0000';

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
): { value: string | null; near: string | null; exact: boolean } | null {
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
      exact: true,
    };
  }
  return { value: null, near: emptyToNull(lead + pre), exact: false };
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
    const start = Math.max(1, Math.min(sibling.StartColumn, copy.length + 1)) - 1;
    const end = Math.max(start, Math.min(sibling.EndColumn, copy.length));
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
  siblings: Finding[] = [],
): { value: string | null; near: string | null; exact: boolean } {
  const resolved = resolveSpanContext(finding, readLine, siblings);
  const ownStripped = withoutValue(resolved.near, resolved.value);
  // A multi-line match (a PEM block, say) is only partly on this line, so the
  // recovered span is a fragment of the real secret and gitleaks' entropy
  // describes the whole. Never call that exact.
  const multiLine = typeof finding.EndLine === 'number' && finding.EndLine > finding.StartLine;
  return {
    value: resolved.value,
    near: ownStripped,
    exact: resolved.exact && !multiLine,
  };
}

/**
 * Resolve the raw `{ value, near }` pair before the `withoutValue` backstop
 * is applied. Split out so `resolveSecretContext` stays a two-line guard and
 * this body stays under the cognitive-complexity gate.
 *
 * Column arithmetic is BYTE-based: gitleaks reports `StartColumn`/`EndColumn`
 * as 1-indexed byte offsets, so slicing the line as a JavaScript string
 * (UTF-16 code units) misaligns the span on any line containing multi-byte
 * UTF-8 before the secret. Session transcripts routinely carry such text.
 *
 * @param finding The gitleaks finding to resolve.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @returns `{ value, near }`, both `string | null`.
 */
function resolveSpanContext(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
  siblings: Finding[] = [],
): { value: string | null; near: string | null; exact: boolean } {
  const raw = readLine(finding.File, finding.StartLine);

  let span: string;
  let lead: string;
  if (raw !== null) {
    const buf = Buffer.from(raw, 'utf8');
    const len = buf.length;
    const startCol = Math.max(1, Math.min(finding.StartColumn, len + 1));
    const endCol = Math.max(startCol, Math.min(finding.EndColumn, len));
    span = buf.subarray(startCol - 1, endCol).toString('utf8');
    lead = maskSiblingSpans(buf, siblings, startCol - 1, endCol)
      .subarray(0, startCol - 1)
      .toString('utf8');
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
      near: emptyToNull(lead + span.slice(0, span.indexOf(finding.Secret))),
      exact: true,
    };
  }

  return {
    value: span.length > 0 ? span : null,
    near: emptyToNull(lead),
    exact: false,
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

// ---------------------------------------------------------------------------
// Block assembly
// ---------------------------------------------------------------------------

/**
 * Build the ` (session: <sid>)` suffix for the `file:` line. Suppressed when
 * the finding has no resolvable session id, OR when the session id is
 * already the file's own basename (the common flat `<sid>.jsonl` shape,
 * where naming it again is redundant): only a nested subagent path, whose
 * basename differs from its session id, shows the parenthetical. The
 * basename is computed by splitting on `/` only (never `node:path`
 * `basename`, which is platform-dependent), mirroring the forward-slash-
 * anchored path regexes in `commands.push.recovery.seams.ts`.
 *
 * @param finding The finding to check.
 * @returns The suffix text, or `''`.
 */
function sessionSuffix(finding: Finding): string {
  const sid = sessionIdFromFinding(finding);
  if (sid === null) return '';
  // Branch-free basename: strip through the last slash. Indexing the split
  // array would leave an unreachable undefined branch behind a coverage
  // ignore, which the patch gate then cannot exercise either way.
  const rawBasename = finding.File.replace(/^.*\//, '');
  const basename = rawBasename.endsWith('.jsonl')
    ? rawBasename.slice(0, -'.jsonl'.length)
    : rawBasename;
  return basename === sid ? '' : ` (session: ${sid})`;
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
  siblings: Finding[] = [],
): string[] {
  const lines = [`  file:  ${finding.File}:${finding.StartLine}${sessionSuffix(finding)}`];
  const { value, near, exact } = resolveSecretContext(finding, readLine, siblings);
  // Entropy is computed by gitleaks on the REAL secret. When alignment fell
  // back to the whole match span, the rendered value is a different string,
  // so quoting the entropy beside it would describe something not shown.
  if (value !== null) {
    lines.push(`  value: ${describeSecret(value, exact ? finding.Entropy : undefined)}`);
  }
  const formattedNear = near !== null ? formatNear(near) : null;
  if (formattedNear !== null) lines.push(`  near:  ${formattedNear}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group findings that the user can safely answer with a single action:
 * same gitleaks fingerprint AND same resolved secret value.
 *
 * Fingerprint alone is NOT sufficient. A fingerprint is `file:rule:startline`
 * with no column component, so two DIFFERENT secrets matching the same rule
 * on the same line share one fingerprint. Grouping on it alone would render
 * only the first, hide the second, and apply one answer to both, so allowing
 * a recognized false positive would silently allow an unrelated real
 * credential sitting beside it.
 *
 * A finding whose secret cannot be resolved (`value === null`) keys off
 * `findingKey`, which includes the column, so it gets its own prompt rather
 * than being merged on an unverified assumption. The same fallback covers an
 * empty `Fingerprint`.
 *
 * @param findings The findings to group.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @returns Groups the user can answer once each, in first-appearance order.
 */
export function groupFindingsForPrompt(
  findings: Finding[],
  readLine: (file: string, line: number) => string | null,
): Finding[][] {
  const groups: Finding[][] = [];
  const indexByKey = new Map<string, number>();
  for (const f of findings) {
    const { value } = resolveSecretContext(f, readLine);
    const key =
      f.Fingerprint.length > 0 && value !== null
        ? `${f.Fingerprint}${GROUP_SEP}${value}`
        : // findingKey omits the fingerprint, so carry it here too, or two
          // findings differing ONLY by fingerprint would merge.
          `${f.Fingerprint}${GROUP_SEP}${findingKey(f)}`;
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, groups.length);
      groups.push([f]);
    } else {
      groups[idx].push(f);
    }
  }
  return groups;
}

/**
 * Count how many OTHER groups share a group's gitleaks fingerprint, i.e. how
 * many additional distinct secrets a single Allow on this group would also
 * suppress. `.gitleaksignore` entries are `file:rule:line`, so an Allow
 * silently covers every finding sharing that fingerprint, including secrets
 * the user was never shown. Zero for the ordinary case.
 *
 * @param groups All prompt groups.
 * @param index Index of the group being rendered.
 * @returns The number of other groups sharing this group's fingerprint.
 */
export function sharedFingerprintPeers(groups: Finding[][], index: number): number {
  const target = groups[index][0].Fingerprint;
  if (target.length === 0) return 0;
  return groups.filter((g, i) => i !== index && g[0].Fingerprint === target).length;
}

/**
 * Build the full prompt text for one fingerprint group: the header line
 * (bare `Finding N/M: <rule>` for a single-member group, or padded with an
 * occurrence/ignore-entry summary for a multi-member group), the rendered
 * body of the group's first finding, and the action menu (`[D]rop session`
 * offered only when the group's first finding resolves a session id).
 *
 * When `peers` is greater than zero, another distinct secret shares this
 * group's ignore fingerprint, so an Allow here suppresses that one too. That
 * is a property of the `file:rule:line` fingerprint format, not something
 * this menu can avoid, so it is surfaced on its own line rather than hidden.
 *
 * @param group One prompt group (at least one finding).
 * @param index 1-based position of this group among all groups.
 * @param total Total number of groups.
 * @param readLine Injected seam returning the raw 1-indexed source line, or null on any failure.
 * @param peers Count of other groups sharing this group's fingerprint.
 * @returns The full prompt text, ready for the caller to append its own input marker.
 */
export function buildPromptHeader(
  group: Finding[],
  index: number,
  total: number,
  readLine: (file: string, line: number) => string | null,
  peers = 0,
  siblings: Finding[] = [],
): string {
  const first = group[0];
  const headerLine =
    group.length === 1
      ? `Finding ${index}/${total}: ${first.RuleID}`
      : `Finding ${index}/${total}: ${first.RuleID.padEnd(RULE_PAD)}  ${group.length} occurrences, 1 ignore entry`;
  const body = renderFindingBlock(first, readLine, siblings);
  if (peers > 0) {
    const other = peers === 1 ? 'secret' : 'secrets';
    body.push(`  warn:  Allow also suppresses ${peers} other distinct ${other} on this line`);
  }
  const sid = sessionIdFromFinding(first);
  const menu =
    sid === null
      ? '  [R]edact  [A]llow  [S]kip (default)'
      : '  [R]edact  [A]llow  [D]rop session  [S]kip (default)';
  return ['', headerLine, ...body, menu, ''].join('\n');
}
