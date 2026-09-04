/**
 * Non-interactive `--redact-all` batch redaction for the push-time recovery
 * menu: `redactAllFindings`, plus its private preflight and dedupe helpers.
 * Pure seams live in `commands.push.recovery.seams.ts`; the interactive
 * Allow-dispatch half lives in `commands.push.recovery.actions.ts`.
 */

import type { PathMap } from '../../../config.ts';
import { applyRedact, preflightRedactable } from './redact.ts';
import { applyMemoryRedact, memoryFileFromFinding, preflightMemoryRedactable } from './memory.ts';
import { applySkillRedact, preflightSkillRedactable, skillFileFromFinding } from './skills.ts';
import type { Finding } from '../gitleaks.scan.ts';
import { scanFile } from '../gitleaks.scan.ts';
import { NomadFatal } from '../../../utils.ts';
import { findingKey, sessionIdFromFinding } from './seams.ts';

/**
 * Deterministic dedupe key for one finding in the `--redact-all` preflight
 * and redact loops: the session id when resolvable, else the memory file's
 * `logical/filename` when the finding is a project-level `memory/*.md`
 * finding, else the skill's `skill:name/relPath` when the finding is a
 * `shared/skills/<name>/<relPath>` finding, else the finding's own
 * `findingKey` (a genuine non-session non-memory non-skill finding, refused
 * individually by `preflightRedactable`).
 *
 * @param f The finding to key.
 * @returns The dedupe key.
 */
function redactAllDedupeKey(f: Finding): string {
  const sid = sessionIdFromFinding(f);
  if (sid !== null) return sid;
  const memParsed = memoryFileFromFinding(f);
  if (memParsed !== null) return `${memParsed.logical}/${memParsed.relPath}`;
  const skillParsed = skillFileFromFinding(f);
  if (skillParsed !== null) return `skill:${skillParsed.name}/${skillParsed.relPath}`;
  return findingKey(f);
}

/**
 * No-mutation preflight for one finding in the `--redact-all` batch. Routes a
 * project-level memory finding (`sid === null` and `memoryFileFromFinding`
 * matches) to `preflightMemoryRedactable`, a skill finding (`sid === null`,
 * not a memory file, `skillFileFromFinding` matches) to
 * `preflightSkillRedactable`; everything else (session findings and genuine
 * non-session non-memory non-skill findings) goes through the unchanged
 * `preflightRedactable`, which itself refuses a non-memory non-skill
 * `sid === null` finding as "not a session transcript".
 *
 * @param f Finding to preflight.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock for the live-session mtime check.
 * @returns A refusal reason string, or null when the finding would proceed.
 */
function redactAllPreflightOne(f: Finding, map: PathMap, nowMs: () => number): string | null {
  if (sessionIdFromFinding(f) === null) {
    if (memoryFileFromFinding(f) !== null) return preflightMemoryRedactable(f, map);
    if (skillFileFromFinding(f) !== null) return preflightSkillRedactable(f);
  }
  return preflightRedactable(f, map, nowMs);
}

/** Loop-invariant, mutated-in-place dedupe state for `redactAllOne`. */
type RedactAllDedupeState = {
  redactedSids: Set<string>;
  redactedMemory: Set<string>;
  redactedSkills: Set<string>;
};

/**
 * Apply the redact action for one finding in the `--redact-all` batch,
 * de-duplicated per session (`redactedSids`), per memory file
 * (`redactedMemory`), or per skill file (`redactedSkills`). A genuine
 * non-session non-memory non-skill finding is a no-op (already refused in
 * the preflight pass, so this branch is unreachable in practice; kept for
 * defense in depth).
 *
 * @param f The finding to redact.
 * @param ts Backup timestamp.
 * @param map Parsed path-map.
 * @param nowMs Injectable clock.
 * @param scan Injectable scan function.
 * @param dedupe Loop-invariant dedupe sets (see `RedactAllDedupeState`).
 */
function redactAllOne(
  f: Finding,
  ts: string,
  map: PathMap,
  nowMs: () => number,
  scan: (p: string) => Finding[] | null,
  dedupe: RedactAllDedupeState,
): void {
  const sid = sessionIdFromFinding(f);
  if (sid !== null) {
    if (dedupe.redactedSids.has(sid)) return;
    if (applyRedact(f, ts, map, nowMs, scan)) dedupe.redactedSids.add(sid);
    return;
  }
  const memParsed = memoryFileFromFinding(f);
  if (memParsed !== null) {
    const memKey = `${memParsed.logical}/${memParsed.relPath}`;
    if (dedupe.redactedMemory.has(memKey)) return;
    if (applyMemoryRedact(f, ts, map, scan)) dedupe.redactedMemory.add(memKey);
    return;
  }
  const skillParsed = skillFileFromFinding(f);
  /* c8 ignore start -- a non-memory, non-session, non-skill finding always
   * refuses in the preflight pass above (all-or-nothing throws before this
   * loop runs), so this branch is unreachable through the public
   * redactAllFindings entry point; kept as defense in depth against a future
   * preflight change. */
  if (skillParsed === null) return;
  /* c8 ignore stop */
  const skillKey = `${skillParsed.name}/${skillParsed.relPath}`;
  if (dedupe.redactedSkills.has(skillKey)) return;
  if (applySkillRedact(f, ts, scan)) dedupe.redactedSkills.add(skillKey);
}

/**
 * Batch-redact all findings non-interactively (the `--redact-all` path).
 * Does not require a TTY. Sessions, project-level `memory/*.md` files, and
 * `shared/skills/**` files are each de-duplicated: the first finding per
 * session, memory file, or skill file triggers the rewrite.
 *
 * All-or-nothing: a no-mutation preflight (`preflightRedactable`,
 * `preflightMemoryRedactable` for a memory finding, or
 * `preflightSkillRedactable` for a skill finding) runs over every distinct
 * session, memory file, or skill file first. If any finding is refused for a
 * deterministic reason (no session id and not a memory or skill file,
 * unlocatable transcript, an active session, an unmapped staged copy, or an
 * unresolvable memory or skill file), the whole batch throws `NomadFatal`
 * BEFORE any local file is rewritten. Without this, an earlier session,
 * memory file, or skill file would be scrubbed on disk and the push would
 * only abort later on the re-scan, leaving surprising partial local state
 * from a flag the user expects to be all-or-nothing.
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

  const dedupe: RedactAllDedupeState = {
    redactedSids: new Set<string>(),
    redactedMemory: new Set<string>(),
    redactedSkills: new Set<string>(),
  };
  for (const f of findings) {
    redactAllOne(f, ts, map, nowMs, scan, dedupe);
  }
}
