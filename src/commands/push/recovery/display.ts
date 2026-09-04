/**
 * Prompt and block assembly for the push-time recovery menu: turns findings
 * into the grouped questions the user answers. The secret description itself
 * lives in `commands.push.recovery.secret-shape.ts`; this module imports from
 * it and from the seams module, never the reverse.
 */

import type { Finding } from '../gitleaks.scan.ts';
import { findingKey, sessionIdFromFinding } from './seams.ts';
import { describeSecret, formatNear, resolveSecretContext } from './secret-shape.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rule id column width when an occurrence summary follows on the header line. */
const RULE_PAD = 24;

/** Separator joining the parts of a grouping key; never appears in a fingerprint or a secret. */
const GROUP_SEP = '\u0000';

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
