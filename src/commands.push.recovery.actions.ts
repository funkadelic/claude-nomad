/**
 * Per-finding action helpers for the push-time recovery menu. Owns the pure
 * seams (`findingKey`, `sessionIdFromFinding`, `parseAction`) and the I/O
 * action dispatchers (`applyAllow`, `applyRedact`, `applyDrop`,
 * `collectActions`, `dispatchActions`, `redactAllFindings`).
 *
 * Imported exclusively by `commands.push.recovery.ts` so the top-level module
 * stays under the 220-line cap.
 */

import { cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { CLAUDE_HOME, HOST, REPO_HOME } from './config.ts';
import { applyRedactions, appendGitleaksIgnore, isRecentlyModified } from './commands.redact.ts';
import { resolveLiveTranscript } from './commands.redact.ts';
import { cmdDropSession } from './commands.drop-session.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { SESSION_PATH } from './push-gitleaks.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';

/** Action a user can assign to one finding in the recovery menu. */
export type FindingAction = 'redact' | 'allow' | 'drop' | 'skip';

/** Prompt function: asks one question and returns the answer. */
export type PromptFn = (prompt: string) => Promise<string>;

/**
 * Build a stable key for a finding used as the actions-map key.
 *
 * @param f The gitleaks finding.
 * @returns A colon-delimited key combining file, start line, and start column.
 */
export function findingKey(f: Finding): string {
  return `${f.File}:${f.StartLine}:${f.StartColumn}`;
}

/**
 * Extract the session id from a finding's File path. Handles both the flat
 * `shared/projects/<logical>/<sid>.jsonl` form (SESSION_PATH) and the deeper
 * subagent form `shared/projects/<logical>/<sid>/...`.
 *
 * @param f The gitleaks finding.
 * @returns The session id, or null when the path matches neither pattern.
 */
export function sessionIdFromFinding(f: Finding): string | null {
  const m = SESSION_PATH.exec(f.File);
  if (m !== null) return m[1] ?? null;
  const sub = /^shared\/projects\/[^/]+\/([^/]+)\//.exec(f.File);
  if (sub !== null) return sub[1] ?? null;
  return null;
}

/**
 * Parse a raw prompt answer into a `FindingAction`. Returns `'skip'` for
 * empty, blank, or unrecognized input (D-02 default).
 *
 * @param raw The untrimmed string returned by the prompt.
 * @returns The corresponding action, defaulting to `'skip'`.
 */
export function parseAction(raw: string): FindingAction {
  const t = raw.trim().toLowerCase();
  if (t === 'r' || t === 'redact') return 'redact';
  if (t === 'a' || t === 'allow') return 'allow';
  if (t === 'd' || t === 'drop') return 'drop';
  return 'skip';
}

/** Apply the Allow action: append the finding's fingerprint to .gitleaksignore. */
export function applyAllow(f: Finding): void {
  appendGitleaksIgnore(f.Fingerprint);
}

/**
 * Apply the Redact action for one finding. Resolves the local transcript,
 * checks the live-session guard, backs up, rewrites in place (same inode),
 * and surgically copies the file back to the staged tree. Returns true on
 * success, false when the session is active or unresolvable.
 *
 * @param f Trigger finding (used for session-id extraction).
 * @param allFindings Full finding set for this run (all findings for the same
 *   session are redacted in one pass to avoid multi-write).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param map Parsed path-map for staged-tree path resolution.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applyRedact(
  f: Finding,
  allFindings: Finding[],
  ts: string,
  map: PathMap,
  nowMs: () => number,
): boolean {
  const sid = sessionIdFromFinding(f);
  if (sid === null) return false;
  const localPath = resolveLiveTranscript(sid);
  if (localPath === null) return false;
  if (isRecentlyModified(statSync(localPath).mtimeMs, nowMs())) return false;

  const sessionFindings = allFindings.filter((sf) => sessionIdFromFinding(sf) === sid);
  backupBeforeWrite(localPath, ts);
  writeFileSync(
    localPath,
    applyRedactions(readFileSync(localPath, 'utf8'), sessionFindings),
    'utf8',
  );

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
 */
export function dispatchActions(
  findings: Finding[],
  actions: Map<string, FindingAction>,
  ts: string,
  map: PathMap,
  nowMs: () => number,
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
      if (applyRedact(f, findings, ts, map, nowMs)) redactedSids.add(sid);
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
 */
export function redactAllFindings(
  findings: Finding[],
  ts: string,
  map: PathMap,
  nowMs: () => number,
): void {
  const redactedSids = new Set<string>();
  for (const f of findings) {
    const sid = sessionIdFromFinding(f);
    if (sid === null || redactedSids.has(sid)) continue;
    if (applyRedact(f, findings, ts, map, nowMs)) redactedSids.add(sid);
  }
}
