/**
 * I/O action dispatchers for the push-time recovery menu: `applyAllow`,
 * `applyRedact`, `collectActions`, `dispatchActions`, `redactAllFindings`,
 * `allowAllFindings`, `allowFindingsByRule`.
 * Pure seams live in `commands.push.recovery.seams.ts`; lock-free drop
 * helper in `commands.push.recovery.drop.ts`.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import type { PathMap } from './config.ts';
import { repoHome } from './config.ts';
import { appendGitleaksIgnore } from './commands.redact.core.ts';
import { applyRedact, preflightRedactable } from './commands.push.recovery.redact.ts';
import { dropSessionFromStaged } from './commands.push.recovery.drop.ts';
import {
  applyMemoryRedact,
  isMemoryFindingPath,
  memoryFileFromFinding,
  preflightMemoryRedactable,
} from './commands.push.recovery.memory.ts';
import {
  applySkillRedact,
  isSkillFindingPath,
  skillFileFromFinding,
} from './commands.push.recovery.skills.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { log, NomadFatal } from './utils.ts';
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
 * range line index, or a thrown read exception). Confines reads to the repo
 * root: an absolute `file` or one whose resolved path escapes `repo` (via
 * `..`) returns null rather than reading an unintended local file.
 */
function makeDefaultReadLine(repo: string): (file: string, line: number) => string | null {
  return (file: string, line: number): string | null => {
    try {
      const repoRoot = resolve(repo);
      const target = resolve(repoRoot, file);
      if (isAbsolute(file) || (target !== repoRoot && !target.startsWith(repoRoot + sep))) {
        return null;
      }
      const content = readFileSync(target, 'utf8');
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
      (ctx === null ? '' : `\n  context: ${ctx}`) +
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
  redactedMemory: Set<string>;
  redactedSkills: Set<string>;
};

/**
 * Apply one finding's triaged action for a project-level `memory/*.md`
 * finding, reached from `dispatchOne` when `sessionIdFromFinding` returns
 * null (a session id cannot be resolved). `'allow'` and `'skip'` are handled
 * by the caller before this function is reached, so only `'redact'` and
 * `'drop'` are meaningful here. `memoryFileFromFinding` returns null for
 * both a genuine non-memory finding and a memory finding it cannot
 * auto-redact (nested `memory/<sub>/x.md`, non-`.md`): `isMemoryFindingPath`
 * distinguishes the two so the latter logs a message pointing the operator at
 * a manual scrub or Skip, rather than silently no-oping like the former.
 *
 * @param f The finding to act on.
 * @param action The triaged action.
 * @param ctx Loop-invariant dispatch context (see `DispatchCtx`).
 */
function dispatchMemory(f: Finding, action: FindingAction, ctx: DispatchCtx): void {
  const parsed = memoryFileFromFinding(f);
  if (parsed === null) {
    if (isMemoryFindingPath(f)) {
      log(`memory path not auto-redactable: ${f.File}; scrub it by hand or choose Skip`);
    }
    return;
  }
  if (action === 'drop') {
    log('memory files cannot be dropped; use Redact or Skip');
    return;
  }
  // Only 'redact' can reach here: dispatchOne handles 'skip' and 'allow'
  // before calling this function, and 'drop' returned just above.
  const memKey = `${parsed.logical}/${parsed.filename}`;
  if (ctx.redactedMemory.has(memKey)) return;
  if (applyMemoryRedact(f, ctx.ts, ctx.map, ctx.scan)) ctx.redactedMemory.add(memKey);
}

/**
 * Apply one finding's triaged action for a `shared/skills/<name>/<relPath>`
 * finding, reached from `dispatchNonSession` when the finding is not a
 * project-level memory file. `'allow'` and `'skip'` are handled by the caller
 * before this function is reached, so only `'redact'` and `'drop'` are
 * meaningful here. A skill is a host-uniform global artifact (no `PathMap`
 * lookup), so unlike `dispatchMemory`, `skillFileFromFinding` returning null
 * here is a genuine no-op: `dispatchNonSession` only calls this function when
 * `isSkillFindingPath` already matched, so a null parse means the shape
 * matched the directory prefix but not the full `<name>/<relPath>` pattern.
 *
 * @param f The finding to act on.
 * @param action The triaged action.
 * @param ctx Loop-invariant dispatch context (see `DispatchCtx`).
 */
function dispatchSkill(f: Finding, action: FindingAction, ctx: DispatchCtx): void {
  const parsed = skillFileFromFinding(f);
  if (parsed === null) return;
  if (action === 'drop') {
    log('skill files cannot be dropped; use Redact or Skip');
    return;
  }
  // Only 'redact' can reach here: dispatchOne handles 'skip' and 'allow'
  // before calling this function, and 'drop' returned just above.
  const skillKey = `${parsed.name}/${parsed.relPath}`;
  if (ctx.redactedSkills.has(skillKey)) return;
  if (applySkillRedact(f, ctx.ts, ctx.scan)) ctx.redactedSkills.add(skillKey);
}

/**
 * Route a `sid === null` finding (no resolvable session id) to the correct
 * non-session dispatcher, extracted so `dispatchOne` stays under the
 * cognitive-complexity gate. Tries project-level memory first, then a
 * global skill file, falling through to a no-op for a genuine non-session
 * non-memory non-skill finding (unchanged from the prior single-branch
 * behavior).
 *
 * @param f The finding to act on.
 * @param action The triaged action.
 * @param ctx Loop-invariant dispatch context (see `DispatchCtx`).
 */
function dispatchNonSession(f: Finding, action: FindingAction, ctx: DispatchCtx): void {
  if (isMemoryFindingPath(f)) {
    dispatchMemory(f, action, ctx);
    return;
  }
  if (isSkillFindingPath(f)) {
    dispatchSkill(f, action, ctx);
  }
  // Genuine non-session non-memory non-skill finding falls through here:
  // unchanged no-op (nothing left to do; the function returns implicitly).
}

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
  if (sid === null) {
    dispatchNonSession(f, action, ctx);
    return;
  }
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
    redactedMemory: new Set<string>(),
    redactedSkills: new Set<string>(),
  };
  for (const f of findings) {
    dispatchOne(f, ctx);
  }
}

/**
 * Deterministic dedupe key for one finding in the `--redact-all` preflight
 * and redact loops: the session id when resolvable, else the memory
 * file's `logical/filename` when the finding is a project-level `memory/*.md`
 * finding, else the finding's own `findingKey` (a genuine non-session
 * non-memory finding, refused individually by `preflightRedactable`).
 *
 * @param f The finding to key.
 * @returns The dedupe key.
 */
function redactAllDedupeKey(f: Finding): string {
  const sid = sessionIdFromFinding(f);
  if (sid !== null) return sid;
  const parsed = memoryFileFromFinding(f);
  return parsed !== null ? `${parsed.logical}/${parsed.filename}` : findingKey(f);
}

/**
 * No-mutation preflight for one finding in the `--redact-all` batch. Routes a
 * project-level memory finding (`sid === null` and `memoryFileFromFinding`
 * matches) to `preflightMemoryRedactable`; everything else (session findings
 * and genuine non-session non-memory findings) goes through the unchanged
 * `preflightRedactable`, which itself refuses a non-memory `sid === null`
 * finding as "not a session transcript".
 *
 * @param f Finding to preflight.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @returns A refusal reason string, or null when the finding would proceed.
 */
function redactAllPreflightOne(f: Finding, map: PathMap, nowMs: () => number): string | null {
  if (sessionIdFromFinding(f) === null && memoryFileFromFinding(f) !== null) {
    return preflightMemoryRedactable(f, map);
  }
  return preflightRedactable(f, map, nowMs);
}

/**
 * Apply the redact action for one finding in the `--redact-all` batch,
 * de-duplicated per session (`redactedSids`) or per memory file
 * (`redactedMemory`). A genuine non-session non-memory finding is a no-op
 * (already refused in the preflight pass, so this branch is unreachable in
 * practice; kept for defense in depth).
 *
 * @param f The finding to redact.
 * @param ts Backup timestamp.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock.
 * @param scan Injectable scan function.
 * @param redactedSids Session ids already redacted this batch.
 * @param redactedMemory Memory files (`logical/filename`) already redacted this batch.
 */
function redactAllOne(
  f: Finding,
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null,
  redactedSids: Set<string>,
  redactedMemory: Set<string>,
): void {
  const sid = sessionIdFromFinding(f);
  if (sid !== null) {
    if (redactedSids.has(sid)) return;
    if (applyRedact(f, ts, map, nowMs, scan)) redactedSids.add(sid);
    return;
  }
  const parsed = memoryFileFromFinding(f);
  /* c8 ignore start -- a non-memory, non-session finding always refuses in
   * the preflight pass above (all-or-nothing throws before this loop runs),
   * so this branch is unreachable through the public redactAllFindings entry
   * point; kept as defense in depth against a future preflight change. */
  if (parsed === null) return;
  /* c8 ignore stop */
  const memKey = `${parsed.logical}/${parsed.filename}`;
  if (redactedMemory.has(memKey)) return;
  if (applyMemoryRedact(f, ts, map, scan)) redactedMemory.add(memKey);
}

/**
 * Batch-redact all findings non-interactively (the `--redact-all` path).
 * Does not require a TTY. Sessions and project-level `memory/*.md` files are
 * each de-duplicated: the first finding per session or per memory file
 * triggers the rewrite.
 *
 * All-or-nothing: a no-mutation preflight (`preflightRedactable`, or
 * `preflightMemoryRedactable` for a memory finding) runs over every distinct
 * session or memory file first. If any finding is refused for a deterministic
 * reason (no session id and not a memory file, unlocatable transcript, an
 * active session, an unmapped staged copy, or an unresolvable memory file),
 * the whole batch throws `NomadFatal` BEFORE any local file is rewritten.
 * Without this, an earlier session or memory file would be scrubbed on disk
 * and the push would only abort later on the re-scan, leaving surprising
 * partial local state from a flag the user expects to be all-or-nothing.
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
  const refusals: string[] = [];
  const preflighted = new Set<string>();
  for (const f of findings) {
    const dedupeKey = redactAllDedupeKey(f);
    if (preflighted.has(dedupeKey)) continue;
    preflighted.add(dedupeKey);
    const reason = redactAllPreflightOne(f, map, nowMs);
    if (reason !== null) refusals.push(reason);
  }
  if (refusals.length > 0) {
    throw new NomadFatal(
      `--redact-all cannot redact every finding, so no changes were made:\n` +
        refusals.map((r) => `  - ${r}`).join('\n') +
        `\n  Re-run without --redact-all to triage these interactively (Drop session / Skip),` +
        ` or end any active session and retry.`,
    );
  }

  const redactedSids = new Set<string>();
  const redactedMemory = new Set<string>();
  for (const f of findings) {
    redactAllOne(f, ts, map, nowMs, scan, redactedSids, redactedMemory);
  }
}
