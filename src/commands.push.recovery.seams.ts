/**
 * Pure, side-effect-free seams for the push-time recovery menu: key
 * derivation, session-id extraction, and prompt-answer parsing. Extracted from
 * `commands.push.recovery.actions.ts` so both modules stay under the 220-line
 * advisory cap.
 */

import type { Finding } from './push-gitleaks.scan.ts';
import { SESSION_PATH } from './push-gitleaks.ts';

/** Action a user can assign to one finding in the recovery menu. */
export type FindingAction = 'redact' | 'allow' | 'drop' | 'skip';

/** Prompt function: asks one question and returns the answer. */
export type PromptFn = (prompt: string) => Promise<string>;

/**
 * Build a stable key for a finding used as the actions-map key. Includes the
 * rule id so two findings at the same file/line/column but different rules
 * produce distinct keys and do not collide in the actions map.
 *
 * @param f The gitleaks finding.
 * @returns A colon-delimited key combining file, start line, start column, and rule id.
 */
export function findingKey(f: Finding): string {
  return `${f.File}:${f.StartLine}:${f.StartColumn}:${f.RuleID}`;
}

/** Valid session id charset: alphanumeric, hyphen, underscore (same as cmdDropSession/cmdRedact). */
const VALID_SID = /^[A-Za-z0-9_-]+$/;

/**
 * Extract the session id from a finding's File path. Handles both the flat
 * `shared/projects/<logical>/<sid>.jsonl` form (SESSION_PATH) and the deeper
 * subagent form `shared/projects/<logical>/<sid>/...`. The extracted id is
 * validated against `/^[A-Za-z0-9_-]+$/` before being returned; path-traversal
 * segments (e.g. `..`) are rejected and cause a null return.
 *
 * @param f The gitleaks finding.
 * @returns The session id, or null when the path matches neither pattern or the
 *   extracted id contains characters outside `[A-Za-z0-9_-]`.
 */
export function sessionIdFromFinding(f: Finding): string | null {
  const m = SESSION_PATH.exec(f.File);
  if (m !== null) {
    const sid = m[1] ?? null;
    return sid !== null && VALID_SID.test(sid) ? sid : null;
  }
  const sub = /^shared\/projects\/[^/]+\/([^/]+)\//.exec(f.File);
  if (sub !== null) {
    const sid = sub[1] ?? null;
    return sid !== null && VALID_SID.test(sid) ? sid : null;
  }
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
