/**
 * Gate for the Allow action's `.gitleaksignore` write.
 *
 * A gitleaks fingerprint is `file:rule:line` with no column, so every finding
 * matching one rule on one line shares it. Writing that fingerprint suppresses
 * all of them, including a DIFFERENT secret the user triaged separately. The
 * recovery menu already warns when that overlap exists, but a warning does not
 * help if the other secret's own action then fails to clean it: the ignore
 * entry is already on disk, the re-scan comes back clean, and the secret is
 * pushed.
 *
 * So the write is deferred until every other finding sharing the fingerprint
 * has actually been cleaned. This generalizes the rule dispatch already
 * applied to Drop, where a dropped session suppresses any later Allow so a
 * stale fingerprint is never written for content held back from the push.
 *
 * Imports run this module -> seams / memory / skills / redact core, never the
 * reverse.
 */

import { appendGitleaksIgnore } from '../../../commands.redact.core.ts';
import { isMemoryFindingPath, memoryFileFromFinding } from './memory.ts';
import { isSkillFindingPath, skillFileFromFinding } from './skills.ts';
import type { Finding } from '../gitleaks.scan.ts';
import { warn } from '../../../utils.ts';
import { type FindingAction, findingKey, sessionIdFromFinding } from './seams.ts';

/**
 * The subset of the dispatch context this gate reads: the chosen actions plus
 * the four success ledgers the dispatch pass fills in. Declared structurally
 * so the caller's richer context satisfies it without being exported.
 */
export type ClearedState = {
  actions: Map<string, FindingAction>;
  droppedSids: Set<string>;
  redactedSids: Set<string>;
  redactedMemory: Set<string>;
  redactedSkills: Set<string>;
};

/**
 * Whether a finding's content was actually dealt with, so suppressing it is
 * honest. True when the user allowed it outright, when its session was
 * dropped from the push, or when its session, memory file or skill file was
 * successfully redacted. A redaction that FAILED (an active session, a span
 * that could not be located verbatim) leaves this false, which is the case
 * this gate exists for.
 *
 * @param f The finding to test.
 * @param state The dispatch pass's action map and success ledgers.
 * @returns True when the finding's content is cleaned or deliberately allowed.
 */
export function isCleared(f: Finding, state: ClearedState): boolean {
  const action = state.actions.get(findingKey(f)) ?? 'skip';
  if (action === 'allow') return true;
  const sid = sessionIdFromFinding(f);
  if (sid !== null) return state.droppedSids.has(sid) || state.redactedSids.has(sid);
  if (isMemoryFindingPath(f)) {
    const parsed = memoryFileFromFinding(f);
    return parsed !== null && state.redactedMemory.has(`${parsed.logical}/${parsed.relPath}`);
  }
  if (isSkillFindingPath(f)) {
    const parsed = skillFileFromFinding(f);
    return parsed !== null && state.redactedSkills.has(`${parsed.name}/${parsed.relPath}`);
  }
  return false;
}

/**
 * Group findings by fingerprint so the gate can ask, for one Allow, what else
 * that same ignore entry would suppress.
 *
 * @param findings All findings from the current verdict.
 * @returns Findings keyed by their gitleaks fingerprint.
 */
function byFingerprint(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    // An empty fingerprint identifies nothing, so grouping on it would lump
    // unrelated findings together and put a blank id in the held-back notice.
    // appendGitleaksIgnore already refuses to write one, so this is precision
    // rather than a second guard on the write.
    if (f.Fingerprint.length === 0) continue;
    const existing = groups.get(f.Fingerprint);
    if (existing === undefined) groups.set(f.Fingerprint, [f]);
    else existing.push(f);
  }
  return groups;
}

/**
 * Write the `.gitleaksignore` entry for every Allow whose fingerprint covers
 * nothing still uncleaned, and report the ones held back.
 *
 * Run this AFTER the redact/drop pass, so the success ledgers are populated.
 * A held-back Allow is not a failure: the finding it covers stays in the tree,
 * the re-scan reports it again, and the push stays blocked until the user
 * resolves the other secret. That is the safe direction.
 *
 * @param findings All findings from the current verdict.
 * @param state The dispatch pass's action map and success ledgers.
 * @param repo Repo root resolved once by the calling command.
 */
export function applyDeferredAllows(findings: Finding[], state: ClearedState, repo: string): void {
  for (const [fingerprint, peers] of byFingerprint(findings)) {
    // Drop wins: content held back from the push needs no ignore entry, and
    // writing one would leave a stale fingerprint behind.
    const allows = peers.filter((p) => {
      if ((state.actions.get(findingKey(p)) ?? 'skip') !== 'allow') return false;
      const sid = sessionIdFromFinding(p);
      return sid === null || !state.droppedSids.has(sid);
    });
    if (allows.length === 0) continue;
    if (peers.every((p) => isCleared(p, state))) {
      appendGitleaksIgnore(fingerprint, repo);
      continue;
    }
    warn(
      `not allowing ${fingerprint}: another secret sharing that line was not cleaned, and the entry would suppress it too`,
    );
  }
}
