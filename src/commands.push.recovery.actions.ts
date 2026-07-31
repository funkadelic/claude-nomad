/**
 * I/O action dispatchers for the push-time recovery menu: `applyAllow`,
 * `collectActions`, `dispatchActions`, `allowAllFindings`,
 * `allowFindingsByRule`.
 * Pure seams live in `commands.push.recovery.seams.ts`; lock-free drop
 * helper in `commands.push.recovery.drop.ts`; the `--redact-all` batch half
 * lives in `commands.push.recovery.redact-all.ts`.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import type { PathMap } from './config.ts';
import { repoHome } from './config.ts';
import { appendGitleaksIgnore } from './commands.redact.core.ts';
import { applyRedact } from './commands.push.recovery.redact.ts';
import { dropSessionFromStaged } from './commands.push.recovery.drop.ts';
import {
  applyMemoryRedact,
  isMemoryFindingPath,
  memoryFileFromFinding,
} from './commands.push.recovery.memory.ts';
import {
  applySkillRedact,
  isSkillFindingPath,
  skillFileFromFinding,
} from './commands.push.recovery.skills.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { log } from './utils.ts';
import { buildPromptHeader, groupFindingsByFingerprint } from './commands.push.recovery.display.ts';
import {
  type FindingAction,
  type PromptFn,
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
 * Walk all findings, grouped by gitleaks fingerprint via
 * `groupFindingsByFingerprint`, and prompt the user for one action per
 * group. The chosen action is applied to every finding in the group, so N
 * occurrences of the same secret on one line ask one question and the
 * returned map still carries one entry per finding (never per group):
 * `dispatchActions` and the `unresolved` filter in
 * `commands.push.recovery.ts` both look up by `findingKey`. Defaults to
 * `'skip'` on empty input. Delegates the entire prompt text to
 * `buildPromptHeader`, so the user can distinguish a real secret from a
 * documented fixture without ever seeing the raw value.
 *
 * @param findings The findings to present.
 * @param prompt An injectable prompt function (one question per group).
 * @param readLine Optional injectable line reader seam. Defaults to a real
 *   reader that resolves `repoHome()` once and reads the repo-relative file.
 * @returns Populated actions map, one entry per finding.
 */
export async function collectActions(
  findings: Finding[],
  prompt: PromptFn,
  readLine?: (file: string, line: number) => string | null,
): Promise<Map<string, FindingAction>> {
  const reader = readLine ?? makeDefaultReadLine(repoHome());
  const groups = groupFindingsByFingerprint(findings);
  const actions = new Map<string, FindingAction>();
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const header = buildPromptHeader(group, i + 1, groups.length, reader);
    const action = parseAction(await prompt(header + '> '));
    for (const f of group) {
      actions.set(findingKey(f), action);
    }
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
 * Apply one finding's triaged action for a project-level `memory/` finding
 * (any file type, arbitrarily nested), reached from `dispatchOne` when
 * `sessionIdFromFinding` returns null (a session id cannot be resolved).
 * `'allow'` and `'skip'` are handled by the caller before this function is
 * reached, so only `'redact'` and `'drop'` are meaningful here.
 * `memoryFileFromFinding` matches any file under `memory/` (flat or nested,
 * `.md` or not), so a null parse here is a bare `memory/` prefix with no
 * trailing file (not a real finding path); it logs a manual-scrub hint rather
 * than silently no-oping.
 *
 * @param f The finding to act on.
 * @param action The triaged action.
 * @param ctx Loop-invariant dispatch context (see `DispatchCtx`).
 */
function dispatchMemory(f: Finding, action: FindingAction, ctx: DispatchCtx): void {
  const parsed = memoryFileFromFinding(f);
  if (parsed === null) {
    // dispatchNonSession only routes memory-path findings here, so a null parse
    // is a bare `memory/` prefix with no trailing file, not a genuine
    // non-memory finding (those no-op in dispatchNonSession).
    log(`memory path not auto-redactable: ${f.File}; scrub it by hand or choose Skip`);
    return;
  }
  if (action === 'drop') {
    log('memory files cannot be dropped; use Redact or Skip');
    return;
  }
  // Only 'redact' can reach here: dispatchOne handles 'skip' and 'allow'
  // before calling this function, and 'drop' returned just above.
  const memKey = `${parsed.logical}/${parsed.relPath}`;
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
