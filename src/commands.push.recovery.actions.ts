/**
 * I/O action dispatchers for the push-time recovery menu: `applyAllow`,
 * `applyRedact`, `collectActions`, `dispatchActions`, `redactAllFindings`,
 * `allowAllFindings`, `allowFindingsByRule`.
 * Pure seams live in `commands.push.recovery.seams.ts`; lock-free drop
 * helper in `commands.push.recovery.drop.ts`.
 */

import type { PathMap } from './config.ts';
import { appendGitleaksIgnore } from './commands.redact.ts';
import { applyRedact } from './commands.push.recovery.redact.ts';
import { dropSessionFromStaged } from './commands.push.recovery.drop.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { log } from './utils.ts';
import {
  type FindingAction,
  type PromptFn,
  findingKey,
  parseAction,
  sessionIdFromFinding,
} from './commands.push.recovery.seams.ts';

export type { FindingAction, PromptFn };
export { dropSessionFromStaged, findingKey, parseAction, sessionIdFromFinding };

/** Apply the Allow action: append the finding's fingerprint to .gitleaksignore. */
export function applyAllow(f: Finding): void {
  appendGitleaksIgnore(f.Fingerprint);
}

/**
 * Batch-allow all findings non-interactively (the `--allow-all` path). Appends
 * every finding's `Fingerprint` to `.gitleaksignore` via the idempotent
 * `appendGitleaksIgnore`. Duplicate fingerprints across findings collapse to one
 * line because `appendGitleaksIgnore` skips fingerprints already present.
 * Does not require a TTY. No re-scan: the caller is responsible for re-staging
 * and re-scanning after this call.
 *
 * @param findings All findings from the current verdict.
 */
export function allowAllFindings(findings: Finding[]): void {
  for (const f of findings) {
    appendGitleaksIgnore(f.Fingerprint);
  }
}

/**
 * Batch-allow findings whose `RuleID` matches `ruleId` (the `--allow <rule>`
 * path). Appends matching fingerprints to `.gitleaksignore` via the idempotent
 * `appendGitleaksIgnore`. Non-matching findings are untouched. Returns the
 * count of fingerprints appended so the caller can emit a no-op notice when
 * zero findings matched. No re-scan: the caller is responsible for re-staging
 * and re-scanning after this call.
 *
 * @param findings All findings from the current verdict.
 * @param ruleId The gitleaks rule id to match against `Finding.RuleID`.
 * @returns Number of fingerprints appended (0 when no findings matched).
 */
export function allowFindingsByRule(findings: Finding[], ruleId: string): number {
  let count = 0;
  for (const f of findings) {
    if (f.RuleID === ruleId) {
      appendGitleaksIgnore(f.Fingerprint);
      count++;
    }
  }
  return count;
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
      (sid === null ? '' : ` (session: ${sid})`) +
      '\n  [R]edact  [A]llow  [D]rop session  [S]kip (default)\n';
    actions.set(findingKey(f), parseAction(await prompt(header + '> ')));
  }
  return actions;
}

/**
 * Loop-invariant context for `dispatchOne`, built once by `dispatchActions`
 * before iterating findings. Bundling these keeps `dispatchOne` to two
 * parameters. The `redactedSids` and `droppedSids` sets are mutated in place so
 * per-session de-duplication is maintained across the caller's loop.
 */
type DispatchCtx = {
  actions: Map<string, FindingAction>;
  ts: string;
  map: PathMap;
  nowMs: () => number;
  scan: (p: string) => Finding[] | null;
  drop: (sid: string, map: PathMap) => boolean;
  redactedSids: Set<string>;
  droppedSids: Set<string>;
};

/**
 * Apply one finding's triaged action against local state. Extracted from
 * `dispatchActions` so each function stays under the cognitive-complexity gate.
 * Drop wins: once a session id appears in `ctx.droppedSids`, subsequent redact
 * or allow actions for findings in that session are skipped.
 *
 * @param f The finding to act on.
 * @param ctx Loop-invariant dispatch context (see `DispatchCtx`).
 */
function dispatchOne(f: Finding, ctx: DispatchCtx): void {
  const action = ctx.actions.get(findingKey(f)) ?? 'skip';
  if (action === 'skip') return;
  const sid = sessionIdFromFinding(f);
  // Drop wins: a dropped session short-circuits every later action for it,
  // including allow, so a stale fingerprint is never written for content that
  // was held back from the push.
  if (sid !== null && ctx.droppedSids.has(sid)) return;
  if (action === 'allow') {
    applyAllow(f);
    return;
  }
  if (sid === null) return;
  if (action === 'drop') {
    ctx.droppedSids.add(sid);
    if (ctx.drop(sid, ctx.map)) {
      log(
        `dropped session ${sid} from this push (local transcript kept; the secret remains in your local copy)`,
      );
    }
    return;
  }
  if (action === 'redact' && !ctx.redactedSids.has(sid)) {
    if (applyRedact(f, ctx.ts, ctx.map, ctx.nowMs, ctx.scan)) ctx.redactedSids.add(sid);
  }
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
 * @param drop Injectable staged-copy remover for the Drop action (default: `dropSessionFromStaged`).
 */
export function dispatchActions(
  findings: Finding[],
  actions: Map<string, FindingAction>,
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null = scanFile,
  drop: (sid: string, map: PathMap) => boolean = dropSessionFromStaged,
): void {
  const ctx: DispatchCtx = {
    actions,
    ts,
    map,
    nowMs,
    scan,
    drop,
    redactedSids: new Set<string>(),
    droppedSids: new Set<string>(),
  };
  for (const f of findings) {
    dispatchOne(f, ctx);
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
    if (applyRedact(f, ts, map, nowMs, scan)) redactedSids.add(sid);
  }
}
