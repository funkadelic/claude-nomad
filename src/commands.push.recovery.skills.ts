/**
 * Host-uniform skill-file resolution and redaction for the push-time
 * recovery menu. A skill is a global artifact keyed only by its name:
 * `~/.claude/skills/<name>/...` maps 1:1 to `shared/skills/<name>/...` on
 * every host, unlike a project-level memory file which needs a
 * `path-map.json` host-mapping lookup
 * (`commands.push.recovery.memory.ts`). No `PathMap`/`HOST` parameter
 * appears anywhere in this module.
 *
 * Provides the same shape as the memory module: a pure finding parser
 * (`skillFileFromFinding`), a double-guarded local-path resolver
 * (`resolveSkillLocalPath`), a no-mutation preflight
 * (`preflightSkillRedactable`), and the in-place redact-plus-copy-back
 * action (`applySkillRedact`). Reuses `applyRedactions`
 * (`commands.redact.core.ts`) and `scanFile` (`push-gitleaks.scan.ts`)
 * unchanged; the `.jsonl` session-subtree and memory paths are untouched.
 *
 * Unlike memory's flat `memory/<file>.md`, a skill is an arbitrarily nested
 * tree (`SKILL.md`, `references/*.md`, `scripts/*.py`, dotfiles, ...), so
 * the finding-path parser captures a multi-segment relative path and the
 * traversal guard validates every segment, not a single filename pattern.
 *
 * Wired into the recovery menu via `dispatchSkill`/`dispatchNonSession` in
 * `commands.push.recovery.actions.ts` and into `--redact-all` in
 * `commands.push.recovery.redact-all.ts`.
 */

import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { claudeHome, repoHome } from './config.ts';
import { isGsdOwned } from './skills-sync.ts';
import { applyRedactions } from './commands.redact.core.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { log } from './utils.ts';

/**
 * Matches a repo-relative POSIX finding path of the form
 * `shared/skills/<name>/<relPath>`, where `relPath` (the second capture
 * group) intentionally allows internal `/` separators so an arbitrarily
 * nested skill file (`references/notes.md`, `scripts/x.py`) is captured
 * whole rather than truncated at the first segment.
 */
const SKILL_FINDING_PATH = /^shared\/skills\/([^/]+)\/(.+)$/;

/** Single path-segment charset allowed for a skill `name`: no separators, no leading dot-traversal. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Matches any finding anywhere under a named skill directory
 * (`shared/skills/<name>/...`), used to route a `sid === null` finding to
 * the skill dispatch branch before falling through to the generic no-op.
 */
const SKILL_DIR_PATH = /^shared\/skills\/[^/]+\//;

/**
 * Parse a gitleaks finding's `File` path into a skill-file reference. Pure.
 * The `relPath` capture may itself contain further `/` separators (a nested
 * skill file); this function does not validate safety, only shape -- see
 * `resolveSkillLocalPath` for the traversal guard.
 *
 * @param f The gitleaks finding.
 * @returns `{name, relPath}` on a match, else null for a non-skill path, a
 *   bare `shared/skills/<name>` with no trailing file, or `shared/skills/`
 *   alone.
 */
export function skillFileFromFinding(f: Finding): { name: string; relPath: string } | null {
  const m = SKILL_FINDING_PATH.exec(f.File);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { name: m[1], relPath: m[2] };
}

/**
 * True when a finding's `File` path lies under a named skill directory
 * (`shared/skills/<name>/...`), regardless of nesting depth.
 *
 * @param f The gitleaks finding.
 * @returns true when the path is under `shared/skills/<name>/`.
 */
export function isSkillFindingPath(f: Finding): boolean {
  return SKILL_DIR_PATH.test(f.File);
}

/**
 * Per-segment traversal guard for a skill's relative path. Rejects an empty
 * path, a leading `/`, any backslash, then splits on `/` and requires every
 * segment be non-empty and not `.` or `..`. A flat single-filename pattern
 * (memory's approach) would incorrectly reject legitimately nested skill
 * files, so every segment is validated independently.
 *
 * @param relPath Candidate relative path extracted from a finding.
 * @returns true when every segment of `relPath` is safe.
 */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) return false;
  const segments = relPath.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/**
 * Resolve a skill finding's `{name, relPath}` to the live local path
 * `~/.claude/skills/<name>/<relPath>`. Host-uniform: no `PathMap`/`HOST`
 * parameter, because a skill maps 1:1 to the same relative location on
 * every host, unlike a project-level memory file
 * (`resolveMemoryLocalPath`).
 *
 * Triple-guarded: `name` and every `relPath` segment are validated before
 * any `join()` (lexical), the joined path is confirmed to stay under the
 * skill root (lexical, string-only), and finally the candidate is
 * canonicalized with `realpathSync` and required to stay under the REAL
 * skills root AND be a regular file (physical). The physical guard is what
 * closes the symlink hole the lexical checks cannot: a leaf symlink, an
 * intermediate symlink directory that resolves outside `~/.claude/skills`, or
 * a directory/other non-file target are all refused, so a redaction can never
 * back up and overwrite an unrelated target reached through a symlink. Also
 * refuses a gsd-owned skill name (`isGsdOwned`, imported from
 * `skills-sync.ts`, the single source of truth for the `gsd-` boundary) so a
 * stale repo-side `gsd-*` entry from the pre-copy-sync symlink era can never
 * be auto-redacted.
 *
 * @param name Skill name extracted from the finding.
 * @param relPath Relative path within the skill extracted from the finding.
 * @returns The absolute local path when name/segments are safe, the skill is
 *   not gsd-owned, and the real target is a regular file under the real skills
 *   root; else null.
 */
export function resolveSkillLocalPath(name: string, relPath: string): string | null {
  if (!SAFE_SKILL_NAME.test(name) || name === '.' || name === '..') return null;
  if (isGsdOwned(name)) return null;
  if (!isSafeRelPath(relPath)) return null;
  const skillsRoot = join(claudeHome(), 'skills');
  const skillRoot = join(skillsRoot, name);
  const localPath = join(skillRoot, ...relPath.split('/'));
  /* c8 ignore start -- defense-in-depth: unreachable once SAFE_SKILL_NAME (no
     path separators in name) and isSafeRelPath (rejects '..'/'.'/empty
     segments above) both pass, join() cannot produce a path escaping
     skillRoot; kept as a cheap first lexical guard in case either upstream
     check is ever weakened */
  if (localPath !== skillRoot && !localPath.startsWith(skillRoot + sep)) return null;
  /* c8 ignore stop */
  // Physical containment guard: the lexical check above is string-only and
  // cannot see through symlinks. Reject a leaf symlink outright (lstat does
  // not follow it), then canonicalize and require the real target stays under
  // the real skills root and is a regular file.
  try {
    if (lstatSync(localPath).isSymbolicLink()) return null;
    const realLocal = realpathSync(localPath);
    const realRoot = realpathSync(skillsRoot);
    if (!realLocal.startsWith(realRoot + sep)) return null;
    if (!statSync(realLocal).isFile()) return null;
  } catch {
    // ENOENT (missing file or missing skills root) or any other stat/realpath
    // failure: treat as not redactable. A resolver must never throw.
    return null;
  }
  return localPath;
}

/**
 * No-scan, no-mutation redactability preflight for one finding, parallel to
 * `preflightMemoryRedactable`. Returns a human-readable refusal reason when
 * the finding is not a skill file or the local file cannot be resolved
 * (unsafe name/path, gsd-owned, missing), else null. Intended for
 * `--redact-all`'s all-or-nothing gate (wired in a later plan).
 *
 * @param f Finding to preflight.
 * @returns A refusal reason string, or null when the finding would proceed.
 */
export function preflightSkillRedactable(f: Finding): string | null {
  const parsed = skillFileFromFinding(f);
  if (parsed === null) return 'a finding is not a skill file';
  const localPath = resolveSkillLocalPath(parsed.name, parsed.relPath);
  if (localPath === null) {
    return `skill file ${parsed.name}/${parsed.relPath}: local file not found or unresolvable`;
  }
  return null;
}

/**
 * Apply the Redact action for one skill finding. Resolves the local file,
 * re-scans it via `scan` (default `scanFile`, no `--redact`, so
 * `Finding.Match` carries the real secret value), and on a non-empty scan:
 * backs up the local file (`backupBeforeWrite`), rewrites it in place via
 * the shared `applyRedactions`, then copies the scrubbed file to the staged
 * `shared/skills/<name>/<relPath>` (creating intermediate directories so a
 * nested `relPath` is preserved). Returns false (with a logged refusal,
 * never the raw secret) when the finding cannot be resolved, the scan
 * itself fails (gitleaks error, `scan` returns null), or the scan finds
 * nothing to redact; no local write occurs in those cases.
 *
 * Reuses `applyRedactions` and `scanFile` unchanged -- both primitives are
 * content-agnostic and already correct regardless of file extension
 * (`.md`, `.py`, `.json`, ...), so no extension special-casing is applied
 * here.
 *
 * @param f Trigger finding (used for name/relPath extraction).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param scan Injectable scan function for the local re-scan (default `scanFile`).
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applySkillRedact(
  f: Finding,
  ts: string,
  scan: (p: string) => Finding[] | null = scanFile,
): boolean {
  const refuse = (msg: string): false => {
    log(msg);
    return false;
  };

  const parsed = skillFileFromFinding(f);
  if (parsed === null) {
    return refuse('could not parse this finding as a skill file; choose Skip.');
  }
  const { name, relPath } = parsed;

  const localPath = resolveSkillLocalPath(name, relPath);
  if (localPath === null) {
    return refuse(`could not locate the local skill file for ${name}/${relPath}; choose Skip.`);
  }

  const findings = scan(localPath);
  if (findings === null) {
    return refuse(`re-scan of ${name}/${relPath} failed; choose Skip.`);
  }
  if (findings.length === 0) {
    return refuse(`nothing to redact in ${name}/${relPath}; choose Skip.`);
  }

  backupBeforeWrite(localPath, ts);
  const before = readFileSync(localPath, 'utf8');
  const after = applyRedactions(before, findings);
  writeFileSync(localPath, after, 'utf8');

  const dest = join(repoHome(), 'shared', 'skills', name, ...relPath.split('/'));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(localPath, dest, { force: true });

  return true;
}
