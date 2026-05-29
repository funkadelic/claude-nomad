import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_HOME } from './config.ts';

/**
 * Replace one secret span in a raw JSONL line. 1-indexed startCol/endCol from
 * gitleaks `StartColumn`/`EndColumn` fields. Pure, no I/O.
 *
 * The replacement token `[REDACTED:<ruleId>]` contains no JSON-special
 * characters, so the result remains valid JSON when the span sits inside a
 * JSON string token.
 *
 * @param line Raw JSONL line text.
 * @param startCol 1-indexed start column (inclusive).
 * @param endCol 1-indexed end column (exclusive slice boundary).
 * @param ruleId Gitleaks rule identifier included in the replacement token.
 * @returns Line with the span replaced by `[REDACTED:<ruleId>]`.
 */
export function redactSpan(line: string, startCol: number, endCol: number, ruleId: string): string {
  return line.slice(0, startCol - 1) + `[REDACTED:${ruleId}]` + line.slice(endCol);
}

/** Minimal finding shape consumed by `applyRedactions`. */
export type RedactFinding = {
  StartLine: number;
  StartColumn: number;
  EndColumn: number;
  RuleID: string;
};

/**
 * Apply all findings for one file in memory. Groups findings by `StartLine`,
 * sorts each group descending by `StartColumn` to avoid offset drift when
 * multiple secrets appear on the same line, then rewrites each line via
 * `redactSpan`. Out-of-range `StartLine` values are silently skipped.
 * Pure, no I/O.
 *
 * @param content Full file content as a single string.
 * @param findings Array of finding descriptors.
 * @returns Redacted file content.
 */
export function applyRedactions(content: string, findings: readonly RedactFinding[]): string {
  const byLine = new Map<number, RedactFinding[]>();
  for (const f of findings) {
    const group = byLine.get(f.StartLine) ?? [];
    group.push(f);
    byLine.set(f.StartLine, group);
  }
  for (const group of byLine.values()) {
    group.sort((a, b) => b.StartColumn - a.StartColumn);
  }
  const lines = content.split('\n');
  for (const [lineNum, group] of byLine) {
    const idx = lineNum - 1;
    let line = lines[idx];
    if (line === undefined) continue;
    for (const f of group) {
      line = redactSpan(line, f.StartColumn, f.EndColumn, f.RuleID);
    }
    lines[idx] = line;
  }
  return lines.join('\n');
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
