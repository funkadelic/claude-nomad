/**
 * I/O action dispatchers for the push-time recovery menu: `applyAllow`,
 * `applyRedact`, `collectActions`, `dispatchActions`, `redactAllFindings`,
 * `allowAllFindings`, `allowFindingsByRule`.
 * Pure seams live in `commands.push.recovery.seams.ts`; lock-free drop
 * helper in `commands.push.recovery.drop.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { repoHome } from './config.ts';
import { appendGitleaksIgnore } from './commands.redact.core.ts';
import { applyRedact } from './commands.push.recovery.redact.ts';
import { dropSessionFromStaged } from './commands.push.recovery.drop.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { log } from './utils.ts';
import {
  type FindingAction,
  type PromptFn,
  buildFindingContext,
  findingKey,
  parseAction,
  sessionIdFromFinding,
} from './commands.push.recovery.seams.ts';

export type { FindingAction, PromptFn };
export { findingKey, parseAction };

/**
 * Apply the Allow action: append the finding's fingerprint to .gitleaksignore.
 *
 * @param f The finding to allow.
 * @param repo Repo root resolved once by the calling command.
 */
function applyAllow(f: Finding, repo: string): void {
  appendGitleaksIgnore(f.Fingerprint, repo);
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
 * @param repo Repo root resolved once by the calling command.
 */
export function allowAllFindings(findings: Finding[], repo: string): void {
  for (const f of findings) {
    appendGitleaksIgnore(f.Fingerprint, repo);
  }
}

/**
 * Batch-allow findings whose `RuleID` matches `ruleId` (the `--allow <rule>`
 * path). Appends matching fingerprints to `.gitleaksignore` via the idempotent
 * `appendGitleaksIgnore`. Non-matching findings are untouched. Returns the
 * count of findings matched so the caller can emit a no-op notice when zero
 * findings matched. Because `appendGitleaksIgnore` is idempotent, the matched
 * count may exceed the number of new lines actually written (duplicates are
 * skipped). No re-scan: the caller is responsible for re-staging and re-scanning
 * after this call.
 *
 * @param findings All findings from the current verdict.
 * @param ruleId The gitleaks rule id to match against `Finding.RuleID`.
 * @param repo Repo root resolved once by the calling command.
 * @returns Number of findings matched (0 when no findings matched).
 */
export function allowFindingsByRule(findings: Finding[], ruleId: string, repo: string): number {
  let count = 0;
  for (const f of findings) {
    if (f.RuleID === ruleId) {
      appendGitleaksIgnore(f.Fingerprint, repo);
      count++;
    }
  }
  return count;
}

/**
 * Build the real line reader for `collectActions`. Resolves `repoHome()` once
 * per call, joins with the finding's repo-relative `File`, reads the file, and
 * returns the 1-indexed line. Returns null on any error (missing file, out-of-
 * range line index, or a thrown read exception).
 */
function makeDefaultReadLine(repo: string): (file: string, line: number) => string | null {
  return (file: string, line: number): string | null => {
    try {
      const content = readFileSync(join(repo, file), 'utf8');
      const lines = content.split(/\r?\n/);
      const idx = line - 1; // convert 1-indexed to 0-indexed
      if (idx < 0 || idx >= lines.length) return null;
      /* c8 ignore next */
      return lines[idx] ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * Walk all findings and prompt the user for one action each. Returns a map
 * from `findingKey` to the chosen action, defaulting to `'skip'` on empty
 * input. Emits a masked `  context: <excerpt>` line under each finding header
 * when `buildFindingContext` returns a non-null excerpt, so the user can
 * distinguish a real secret from a documented fixture without seeing the raw value.
 *
 * @param findings The findings to present.
 * @param prompt An injectable prompt function (one question per call).
 * @param readLine Optional injectable line reader seam. Defaults to a real
 *   reader that resolves `repoHome()` once and reads the repo-relative file.
 * @returns Populated actions map.
 */
export async function collectActions(
  findings: Finding[],
  prompt: PromptFn,
  readLine?: (file: string, line: number) => string | null,
): Promise<Map<string, FindingAction>> {
  const reader = readLine ?? makeDefaultReadLine(repoHome());
  const actions = new Map<string, FindingAction>();
  for (const f of findings) {
    const sid = sessionIdFromFinding(f);
    const ctx = buildFindingContext(f, reader);
    const header =
      `\nFinding: ${f.RuleID} in ${f.File} line ${f.StartLine}` +
      (sid === null ? '' : ` (session: ${sid})`) +
      (ctx !== null ? `\n  context: ${ctx}` : '') +
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
  repo: string;
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
    applyAllow(f, ctx.repo);
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
 * @param opts Loop-invariant inputs for the dispatch pass.
 * @param opts.ts Backup timestamp.
 * @param opts.map Parsed path-map.
 * @param opts.nowMs Injectable clock.
 * @param opts.repo Repo root resolved once by the calling command.
 * @param opts.scan Injectable scan function for `applyRedact` (default: `scanFile`).
 * @param opts.drop Injectable staged-copy remover for the Drop action (default: `dropSessionFromStaged`).
 */
export function dispatchActions(
  findings: Finding[],
  actions: Map<string, FindingAction>,
  opts: {
    ts: string;
    map: PathMap;
    nowMs: () => number;
    repo: string;
    scan?: (p: string) => Finding[] | null;
    drop?: (sid: string, map: PathMap) => boolean;
  },
): void {
  const { ts, map, nowMs, repo, scan = scanFile, drop = dropSessionFromStaged } = opts;
  const ctx: DispatchCtx = {
    actions,
    ts,
    map,
    nowMs,
    repo,
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
