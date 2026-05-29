/**
 * I/O action dispatchers for the push-time recovery menu: `applyAllow`,
 * `applyRedact`, `collectActions`, `dispatchActions`, `redactAllFindings`.
 * Pure seams (`findingKey`, `sessionIdFromFinding`, `parseAction`) live in
 * `commands.push.recovery.seams.ts`.
 */

import { cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import {
  applyRedactions,
  appendGitleaksIgnore,
  isRecentlyModified,
  resolveLiveTranscript,
} from './commands.redact.ts';
import { cmdDropSession } from './commands.drop-session.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';
import {
  type FindingAction,
  type PromptFn,
  findingKey,
  parseAction,
  sessionIdFromFinding,
} from './commands.push.recovery.seams.ts';

export type { FindingAction, PromptFn };
export { findingKey, parseAction, sessionIdFromFinding };

/** Apply the Allow action: append the finding's fingerprint to .gitleaksignore. */
export function applyAllow(f: Finding): void {
  appendGitleaksIgnore(f.Fingerprint);
}

/**
 * Apply the Redact action for one finding. Resolves the local transcript,
 * checks the live-session guard, re-scans the local file (without `--redact`)
 * to obtain real secret values, backs up, rewrites in place (same inode), and
 * surgically copies the file back to the staged tree. Returns true on success,
 * false when the session is active, unresolvable, or the local re-scan fails.
 *
 * The push-verdict findings (`f`, `allFindings`) drive which sessions to act on
 * and provide session-id extraction, but their `Match` fields come from a
 * `--redact` scan and are masked. The local re-scan (via `scan`) runs WITHOUT
 * `--redact` so `applyRedactions` receives the real secret values.
 *
 * @param f Trigger finding (used for session-id extraction).
 * @param allFindings Full finding set for this run (used for session-id
 *   matching; values are masked and not used for redaction).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param map Parsed path-map for staged-tree path resolution.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @param scan Injectable scan function for local re-scan (default: `scanFile`).
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applyRedact(
  f: Finding,
  allFindings: Finding[],
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null = scanFile,
): boolean {
  const sid = sessionIdFromFinding(f);
  if (sid === null) return false;
  const localPath = resolveLiveTranscript(sid);
  if (localPath === null) return false;
  if (isRecentlyModified(statSync(localPath).mtimeMs, nowMs())) return false;

  // Re-scan without --redact to get real secret values for value-based redaction.
  // Push-verdict findings have masked Match fields and cannot be used directly.
  const realFindings = scan(localPath);
  if (realFindings === null) return false;
  if (realFindings.length === 0) return false;

  backupBeforeWrite(localPath, ts);
  writeFileSync(localPath, applyRedactions(readFileSync(localPath, 'utf8'), realFindings), 'utf8');

  for (const [logical, hostMap] of Object.entries(map.projects)) {
    const abs = hostMap[HOST];
    if (abs === undefined) continue;
    if (localPath.startsWith(join(CLAUDE_HOME, 'projects', encodePath(abs)))) {
      cpSync(localPath, join(REPO_HOME, 'shared', 'projects', logical, `${sid}.jsonl`), {
        force: true,
      });
      break;
    }
  }
  return true;
}

/**
 * Walk all findings and prompt the user for one action each. Returns a map
 * from `findingKey` to the chosen action, defaulting to `'skip'` on empty
 * input.
 *
 * @param findings The findings to present.
 * @param prompt An injectable prompt function (one question per call).
 * @returns Populated actions map.
 */
export async function collectActions(
  findings: Finding[],
  prompt: PromptFn,
): Promise<Map<string, FindingAction>> {
  const actions = new Map<string, FindingAction>();
  for (const f of findings) {
    const sid = sessionIdFromFinding(f);
    const header =
      `\nFinding: ${f.RuleID} in ${f.File} line ${f.StartLine}` +
      (sid !== null ? ` (session: ${sid})` : '') +
      '\n  [R]edact  [A]llow  [D]rop session  [S]kip (default)\n';
    actions.set(findingKey(f), parseAction(await prompt(header + '> ')));
  }
  return actions;
}

/**
 * Dispatch all non-skip actions from the triage map against local state.
 * Redacted sessions are de-duplicated: the first finding for a given session
 * triggers the in-place rewrite; subsequent findings for the same session are
 * skipped (the rewrite already covered all findings in one pass).
 *
 * @param findings Full findings list from the current verdict.
 * @param actions The action map returned by `collectActions`.
 * @param ts Backup timestamp.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock.
 * @param scan Injectable scan function for `applyRedact` (default: `scanFile`).
 */
export function dispatchActions(
  findings: Finding[],
  actions: Map<string, FindingAction>,
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null = scanFile,
): void {
  const redactedSids = new Set<string>();
  for (const f of findings) {
    const action = actions.get(findingKey(f)) ?? 'skip';
    if (action === 'skip') continue;
    if (action === 'allow') {
      applyAllow(f);
      continue;
    }
    const sid = sessionIdFromFinding(f);
    if (sid === null) continue;
    if (action === 'drop') {
      cmdDropSession(sid);
      continue;
    }
    if (action === 'redact' && !redactedSids.has(sid)) {
      if (applyRedact(f, findings, ts, map, nowMs, scan)) redactedSids.add(sid);
    }
  }
}

/**
 * Batch-redact all findings non-interactively (the `--redact-all` path).
 * Does not require a TTY. Findings with no resolvable session id are skipped.
 * Sessions are de-duplicated: the first finding per session triggers the
 * rewrite.
 *
 * @param findings All findings from the current verdict.
 * @param ts Backup timestamp.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock.
 * @param scan Injectable scan function for `applyRedact` (default: `scanFile`).
 */
export function redactAllFindings(
  findings: Finding[],
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null = scanFile,
): void {
  const redactedSids = new Set<string>();
  for (const f of findings) {
    const sid = sessionIdFromFinding(f);
    if (sid === null || redactedSids.has(sid)) continue;
    if (applyRedact(f, findings, ts, map, nowMs, scan)) redactedSids.add(sid);
  }
}
