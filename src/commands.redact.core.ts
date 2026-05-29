import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';

/**
 * Replace every occurrence of a literal secret value in a raw line. Uses
 * split/join to avoid regex escaping and to replace all occurrences. Pure,
 * no I/O.
 *
 * The replacement token `[REDACTED:<ruleId>]` contains no JSON-special
 * characters, so the result remains valid JSON when the value sits inside a
 * JSON string token.
 *
 * @param line Raw JSONL line text.
 * @param match Literal secret value to replace (empty string is a no-op).
 * @param ruleId Gitleaks rule identifier included in the replacement token.
 * @returns Line with all occurrences of `match` replaced by `[REDACTED:<ruleId>]`.
 */
export function redactValue(line: string, match: string, ruleId: string): string {
  if (match === '') return line;
  return line.split(match).join(`[REDACTED:${ruleId}]`);
}

/** Minimal finding shape consumed by `applyRedactions`. */
export type RedactFinding = {
  StartLine: number;
  Match: string;
  RuleID: string;
};

/**
 * Apply all findings for one file in memory. Replaces each finding's `Match`
 * value globally across the whole content string (split/join, no column
 * arithmetic). To avoid a shorter secret being a substring of a longer one
 * causing a partial match, findings are sorted by `Match.length` descending so
 * the longer secret is replaced first. Findings with an empty `Match` are
 * silently skipped (a defensive guard: an empty match would otherwise inject
 * the token between every character). Pure, no I/O.
 *
 * @param content Full file content as a single string.
 * @param findings Array of finding descriptors.
 * @returns Redacted file content.
 */
export function applyRedactions(content: string, findings: readonly RedactFinding[]): string {
  const sorted = [...findings].sort((a, b) => b.Match.length - a.Match.length);
  let result = content;
  for (const f of sorted) {
    if (f.Match === '') continue;
    result = result.split(f.Match).join(`[REDACTED:${f.RuleID}]`);
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
 * Append one sanitized fingerprint line to `REPO_HOME/.gitleaksignore`. The
 * fingerprint is passed through `formatFingerprint` to strip embedded newlines
 * before the append.
 *
 * @param fingerprint Raw fingerprint from `Finding.Fingerprint`.
 */
export function appendGitleaksIgnore(fingerprint: string): void {
  appendFileSync(join(REPO_HOME, '.gitleaksignore'), formatFingerprint(fingerprint), 'utf8');
}
