/**
 * Pure, side-effect-free seams for the push-time recovery menu: key
 * derivation, session-id extraction, and prompt-answer parsing. Extracted
 * from `commands/push/recovery/actions.ts` so it, its `--redact-all` sibling
 * `commands/push/recovery/redact-all.ts`, and this module all stay under the
 * 220-line advisory cap. Finding-context rendering lives in
 * `commands/push/recovery/display.ts`, which imports `sessionIdFromFinding`
 * from this module.
 */

import type { Finding } from '../gitleaks.scan.ts';
import { SESSION_PATH } from '../gitleaks.ts';
import { isMemoryFindingPath } from './memory.ts';

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
 * Matches ANY file nested under a session directory,
 * `shared/projects/<logical>/<sid>/<...anything>`, regardless of extension.
 * Deliberately broader than `SUBAGENT_SESSION_PATH` in `commands/push/gitleaks.ts`
 * (which requires a `.jsonl` suffix for its FATAL-hint-text purpose): the
 * redaction path this function drives (`applyRedact` in
 * `commands/push/recovery/redact.ts`) already redacts every file in a
 * session's subtree, not just `.jsonl` transcripts (subagents, `.meta.json`,
 * `tool-results/*.txt`), so session-id resolution must match that scope. This
 * pattern alone would also capture `"memory"` as a false session id for any
 * finding under a project-level `memory/` directory; the `isMemoryFindingPath`
 * pre-check below excludes that whole subtree (flat or nested) explicitly
 * instead.
 */
const SUBTREE_PATH = /^shared\/projects\/[^/]+\/([^/]+)\/.+$/;

/**
 * Extract the session id from a finding's File path. Any finding under a
 * project-level `memory/` directory is excluded FIRST via `isMemoryFindingPath`
 * (imported from `commands/push/recovery/memory.ts`, the single source of truth
 * for the memory-path shape) and returns null rather than mis-capturing
 * `"memory"` as a session id, for both the flat `memory/<file>.md` shape and a
 * nested `memory/<subdir>/<file>.md`. Otherwise handles both the flat
 * `shared/projects/<logical>/<sid>.jsonl` form (`SESSION_PATH`) and any
 * deeper file under a session directory,
 * `shared/projects/<logical>/<sid>/...` (`SUBTREE_PATH`). The extracted id is
 * validated against `/^[A-Za-z0-9_-]+$/` before being returned;
 * path-traversal segments (e.g. `..`) are rejected and cause a null return.
 *
 * @param f The gitleaks finding.
 * @returns The session id, or null when the path is a memory file, matches
 *   neither session pattern, or the extracted id contains characters outside
 *   `[A-Za-z0-9_-]`.
 */
export function sessionIdFromFinding(f: Finding): string | null {
  if (isMemoryFindingPath(f)) return null;
  // Try the flat `<sid>.jsonl` form first, then any nested subtree file. Both
  // patterns capture the session id at group 1; a matched capture group is
  // always a string, so no nullish guard on `m[1]` is needed.
  const m = SESSION_PATH.exec(f.File) ?? SUBTREE_PATH.exec(f.File);
  if (m === null) return null;
  const sid = m[1];
  return VALID_SID.test(sid) ? sid : null;
}

/**
 * Parse a raw prompt answer into a `FindingAction`. Returns `'skip'` for
 * empty, blank, or unrecognized input, the safe default that leaves a
 * finding unresolved rather than silently choosing an action for the user.
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
