import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal finding shape consumed by `applyRedactions`. */
export type RedactFinding = {
  StartLine: number;
  Match: string;
  RuleID: string;
};

/** A half-open byte interval `[start, end)` derived from a `Match` value. */
type MatchInterval = {
  start: number;
  end: number;
  ruleId: string;
};

/**
 * Locate every occurrence of each finding's `Match` value in `content` using
 * `indexOf`. Findings with an empty `Match` are skipped. Multiple
 * non-overlapping occurrences of the same value are each recorded as a
 * separate interval. Offsets are value-derived, not column-derived, so they
 * are always correct regardless of gitleaks column alignment.
 *
 * @param content Full file content as a single string.
 * @param findings Array of finding descriptors.
 * @returns Array of `{start, end, ruleId}` intervals (unmerged, unsorted).
 */
export function collectMatchIntervals(
  content: string,
  findings: readonly RedactFinding[],
): MatchInterval[] {
  const intervals: MatchInterval[] = [];
  for (const f of findings) {
    const match = f.Match;
    if (match === '') continue;
    let from = 0;
    let pos = content.indexOf(match, from);
    while (pos !== -1) {
      intervals.push({ start: pos, end: pos + match.length, ruleId: f.RuleID });
      from = pos + match.length;
      pos = content.indexOf(match, from);
    }
  }
  return intervals;
}

/**
 * Sort and merge a list of (possibly overlapping or adjacent) intervals into a
 * minimal list of non-overlapping spans. Sort order is start ascending, then
 * end descending so that a longer interval at the same start position wins its
 * `ruleId`. Overlapping or adjacent intervals are folded into one span that
 * extends to the maximum end seen, keeping the first span's `ruleId`.
 *
 * @param intervals Unmerged intervals from `collectMatchIntervals`.
 * @returns Sorted, merged, non-overlapping intervals.
 */
export function mergeIntervals(intervals: MatchInterval[]): MatchInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || b.end - a.end);
  let last = { ...sorted[0] };
  const merged: MatchInterval[] = [last];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      last = { ...cur };
      merged.push(last);
    }
  }
  return merged;
}

/**
 * Apply all findings for one file in memory. Collects every occurrence of each
 * finding's `Match` value via `indexOf`, merges overlapping and adjacent spans
 * into non-overlapping intervals, then replaces each interval right-to-left so
 * earlier offsets remain valid. Findings with an empty `Match` are silently
 * skipped. Returns `content` unchanged when there are no findings or no
 * occurrences are found.
 *
 * The replacement token `[REDACTED:<ruleId>]` is byte-identical to the previous
 * format. Right-to-left replacement guarantees that overlapping matches (e.g.
 * two findings whose `Match` values share a middle span) are replaced by a
 * single token covering the full union, leaving no fragment. Pure, no I/O.
 *
 * @param content Full file content as a single string.
 * @param findings Array of finding descriptors.
 * @returns Redacted file content.
 */
export function applyRedactions(content: string, findings: readonly RedactFinding[]): string {
  const raw = collectMatchIntervals(content, findings);
  if (raw.length === 0) return content;
  const merged = mergeIntervals(raw);
  let result = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end, ruleId } = merged[i];
    result = result.slice(0, start) + `[REDACTED:${ruleId}]` + result.slice(end);
  }
  return result;
}

/**
 * Format a gitleaks fingerprint for appending to `.gitleaksignore`. Strips any
 * embedded `\r` or `\n` characters (a newline in a fingerprint must not inject
 * extra ignore lines) and appends exactly one trailing newline. Pure.
 *
 * @param fingerprint Raw fingerprint string from `Finding.Fingerprint`.
 * @returns Sanitized fingerprint with a single trailing newline.
 */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[\r\n]/g, '') + '\n';
}

/**
 * True if the file mtime is within `thresholdMs` of `nowMs` (heuristic for a
 * live session that Claude Code may still be writing). Pure, injectable for
 * tests.
 *
 * @param mtimeMs File modification time in milliseconds.
 * @param nowMs Current epoch time in milliseconds.
 * @param thresholdMs Threshold window in milliseconds (default 5 minutes).
 * @returns True when the file was modified within the threshold.
 */
export function isRecentlyModified(
  mtimeMs: number,
  nowMs: number,
  thresholdMs = 5 * 60 * 1000,
): boolean {
  return nowMs - mtimeMs < thresholdMs;
}

/**
 * Return true when `fingerprint` is a well-formed gitleaks fingerprint that is
 * safe to append to `.gitleaksignore`. Rejects: empty or whitespace-only
 * values, values containing `\r` or `\n` (newline-injection guard), and
 * over-length values (cap at 512 characters). Accepts any non-blank text within
 * the length limit that contains no `\r` or `\n` anywhere, which covers the
 * `file:rule:line` opaque shape that gitleaks fingerprints carry. Returns a
 * boolean, never throws.
 *
 * @param fingerprint Candidate fingerprint string.
 * @returns True when the fingerprint is valid and safe to append.
 */
export function isValidFingerprint(fingerprint: string): boolean {
  // Test the RAW value for CR/LF: trim() would strip a trailing newline and let
  // it slip past, so the non-blank check uses trim() while the newline guard
  // runs against the untrimmed value.
  return (
    fingerprint.trim().length > 0 && fingerprint.length <= 512 && /^[^\r\n]+$/.test(fingerprint)
  );
}

/**
 * Return true when `line` (already trimmed) is already present among `lines`.
 * Extracted to keep `appendGitleaksIgnore` under the cognitive-complexity gate.
 *
 * @param line Sanitized fingerprint without the trailing newline.
 * @param lines Existing lines from the ignore file.
 * @returns True when the line is already present.
 */
function isAlreadyPresent(line: string, lines: string[]): boolean {
  return lines.includes(line);
}

/**
 * Append one sanitized fingerprint line to `REPO_HOME/.gitleaksignore`,
 * idempotently. Reads existing lines first and skips the write when the
 * sanitized fingerprint is already present, ensuring no duplicate lines are
 * ever written. When the file does not exist it is created with exactly one
 * line and no leading blank. Empty or whitespace-only fingerprints are silently
 * skipped (never written). When the existing file does not end in a newline a
 * separating newline is written first, so a trailing-newline-less file cannot
 * fuse two fingerprints onto one line. The fingerprint is passed through
 * `formatFingerprint` to strip embedded newlines before any comparison or write.
 *
 * @param fingerprint Raw fingerprint from `Finding.Fingerprint`.
 * @param repo Repo root resolved once by the calling command.
 */
export function appendGitleaksIgnore(fingerprint: string, repo: string): void {
  const sanitized = fingerprint.replace(/[\r\n]/g, '').trim();
  if (sanitized.length === 0) return;
  const ignPath = join(repo, '.gitleaksignore');
  // Read atomically: attempt the read and treat any failure (missing file) as
  // empty, rather than an existsSync check-then-read that races on the file.
  let raw: string;
  try {
    raw = readFileSync(ignPath, 'utf8');
  } catch {
    raw = '';
  }
  const existing = raw.split('\n').filter((l) => l.length > 0);
  if (isAlreadyPresent(sanitized, existing)) return;
  const needsLeadingNewline = raw.length > 0 && !raw.endsWith('\n');
  const prefix = needsLeadingNewline ? '\n' : '';
  appendFileSync(ignPath, prefix + formatFingerprint(sanitized), 'utf8');
}
