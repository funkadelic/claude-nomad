/**
 * Project-level memory-file resolution and redaction for the push-time
 * recovery menu. `memory/` is a PROJECT-LEVEL sibling of every session's
 * `<sid>/` subtree, so the existing session-subtree redactor
 * (`commands.redact.subtree.ts`,
 * `commands.push.recovery.redact.ts`) structurally cannot reach it: it is
 * scoped to one `<sid>/` directory, one level below where `memory/` lives.
 *
 * This module provides the parallel, explicitly project-level path: a pure
 * finding parser (`memoryFileFromFinding`), a guarded local-path resolver
 * (`resolveMemoryLocalPath`), a no-mutation preflight
 * (`preflightMemoryRedactable`), and the in-place redact-plus-copy-back
 * action (`applyMemoryRedact`). Reuses `applyRedactions`
 * (`commands.redact.core.ts`) and `scanFile` (`push-gitleaks.scan.ts`)
 * unchanged; the `.jsonl` session-subtree path is untouched.
 *
 * Like the skill resolver (`commands.push.recovery.skills.ts`), `memory/` is
 * treated as an arbitrarily nested tree of any file type, not a flat
 * `<file>.md` directory: the finding-path parser captures a multi-segment
 * relative path, the shared `isSafeRelPath` guard validates every segment, and
 * a physical `lstat`/`realpath`/`isFile` guard closes the symlink hole the
 * lexical checks cannot. Unlike a skill (a host-uniform global artifact), a
 * memory file lives under a project encoded dir, so resolution still needs the
 * `path-map.json` host-mapping lookup (`PathMap`/`HOST`/`encodePath`).
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

import type { PathMap } from './config.ts';
import { claudeHome, HOST, repoHome } from './config.ts';
import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { applyRedactions } from './commands.redact.core.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { isSafeRelPath } from './rel-path-guard.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';
import { log, warn } from './utils.ts';

/**
 * Matches a repo-relative POSIX finding path of the form
 * `shared/projects/<logical>/memory/<relPath>`, where `relPath` (the second
 * capture group) intentionally allows internal `/` separators and any file
 * extension so a nested `memory/<subdir>/x.md` or a non-`.md` memory file
 * (`memory/notes.txt`) is captured whole rather than rejected. Mirrors the
 * skill parser's `shared/skills/<name>/(.+)$` shape.
 */
const MEMORY_FINDING_PATH = /^shared\/projects\/([^/]+)\/memory\/(.+)$/;

/**
 * Matches any finding under a project-level `memory/` directory. Kept distinct
 * from `MEMORY_FINDING_PATH` for the `isMemoryFindingPath` routing predicate,
 * which only needs the directory prefix (no captures).
 */
const MEMORY_DIR_PATH = /^shared\/projects\/[^/]+\/memory\//;

/**
 * Parse a gitleaks finding's `File` path into a project-level memory-file
 * reference. Pure. The `relPath` capture may itself contain further `/`
 * separators (a nested memory file) and any extension; this function does not
 * validate safety, only shape -- see `resolveMemoryLocalPath` for the
 * traversal + physical guard. Returns null for a non-memory path or a bare
 * `memory/` with no trailing file.
 *
 * @param f The gitleaks finding.
 * @returns `{logical, relPath}` on a match, else null.
 */
export function memoryFileFromFinding(f: Finding): { logical: string; relPath: string } | null {
  const m = MEMORY_FINDING_PATH.exec(f.File);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { logical: m[1], relPath: m[2] };
}

/**
 * True when a finding's `File` path lies under a project-level `memory/`
 * directory (flat or nested). Used to exclude the whole memory subtree from
 * session-id resolution so a nested `memory/<subdir>/x.md` cannot mis-resolve
 * to a bogus `"memory"` session id and steer the operator toward Allow.
 *
 * @param f The gitleaks finding.
 * @returns true when the path is under a project-level `memory/` directory.
 */
export function isMemoryFindingPath(f: Finding): boolean {
  return MEMORY_DIR_PATH.test(f.File);
}

/**
 * Resolve a memory finding's `{logical, relPath}` to the live local path
 * `~/.claude/projects/<encoded>/memory/<relPath>`. Triple-guarded, mirroring
 * `resolveSkillLocalPath`:
 *
 * 1. `assertSafeLogical` guards the `logical` segment (throws `NomadFatal` on
 *    `..`/separator) before any join. Direct lookup (no reverse search): the
 *    finding path already names the exact `logical`.
 * 2. `isSafeRelPath` (shared with the skill resolver) validates every segment
 *    of `relPath` (rejects empty/`.`/`..`, a leading `/`, or any backslash),
 *    then the joined path is confirmed to stay under the memory root
 *    (lexical, string-only).
 * 3. The candidate is canonicalized with `realpathSync` and required to stay
 *    under the REAL memory root AND be a regular file (physical). This closes
 *    the symlink hole the lexical checks cannot: a leaf symlink, an
 *    intermediate symlink dir resolving outside `memory/`, or a
 *    directory/other non-file target are all refused, so a redaction can never
 *    back up and overwrite an unrelated target reached through a symlink.
 *
 * @param logical Project logical name extracted from the finding.
 * @param relPath Relative path within `memory/` extracted from the finding.
 * @param map Parsed path-map for the host-mapping lookup.
 * @returns The absolute local path when the host mapping exists and the real
 *   target is a regular file under the real memory root, else null.
 */
export function resolveMemoryLocalPath(
  logical: string,
  relPath: string,
  map: PathMap,
): string | null {
  assertSafeLogical(logical);
  if (!isSafeRelPath(relPath)) return null;
  const abs = map.projects[logical]?.[HOST];
  if (abs === undefined) return null;
  const memoryRoot = join(claudeHome(), 'projects', encodePath(abs), 'memory');
  const localPath = join(memoryRoot, ...relPath.split('/'));
  /* c8 ignore start -- defense-in-depth: unreachable once isSafeRelPath
     (rejects '..'/'.'/empty segments and backslashes above) passes, join()
     cannot produce a path escaping memoryRoot; kept as a cheap first lexical
     guard in case the upstream check is ever weakened */
  if (localPath !== memoryRoot && !localPath.startsWith(memoryRoot + sep)) return null;
  /* c8 ignore stop */
  // Physical containment guard: the lexical check above is string-only and
  // cannot see through symlinks. Reject a leaf symlink outright (lstat does
  // not follow it), then canonicalize and require the real target stays under
  // the real memory root and is a regular file.
  try {
    if (lstatSync(localPath).isSymbolicLink()) return null;
    const realLocal = realpathSync(localPath);
    const realRoot = realpathSync(memoryRoot);
    if (!realLocal.startsWith(realRoot + sep)) return null;
    if (!statSync(realLocal).isFile()) return null;
  } catch {
    // ENOENT (missing file or missing memory root) or any other stat/realpath
    // failure: treat as not redactable. A resolver must never throw.
    return null;
  }
  return localPath;
}

/**
 * No-scan, no-mutation redactability preflight for one finding, parallel to
 * `preflightRedactable` in `commands.push.recovery.redact.ts`. Returns a
 * human-readable refusal reason when the finding is not a memory file or the
 * local file cannot be resolved (unmapped host, missing file), else null.
 * Consumed by `--redact-all`'s all-or-nothing preflight gate in
 * `commands.push.recovery.redact-all.ts`.
 *
 * @param f Finding to preflight.
 * @param map Parsed path-map for the host-mapping lookup.
 * @returns A refusal reason string, or null when the finding would proceed.
 */
export function preflightMemoryRedactable(f: Finding, map: PathMap): string | null {
  const parsed = memoryFileFromFinding(f);
  if (parsed === null) return 'a finding is not a project-level memory file';
  const localPath = resolveMemoryLocalPath(parsed.logical, parsed.relPath, map);
  if (localPath === null) {
    return `memory file ${parsed.logical}/memory/${parsed.relPath}: local file not found or unmapped`;
  }
  return null;
}

/**
 * Apply the Redact action for one project-level memory finding. Resolves the
 * local file, re-scans it via `scan` (default `scanFile`, no `--redact`, so
 * `Finding.Match` carries the real secret value), and on a non-empty scan:
 * backs up the local file (`backupBeforeWrite`), rewrites it in place via the
 * shared `applyRedactions`, then copies the scrubbed file to the staged
 * `shared/projects/<logical>/memory/<relPath>` (creating intermediate
 * directories so a nested `relPath` is preserved). Returns false (with a
 * logged refusal, never the raw secret) when the finding cannot be resolved,
 * the scan itself fails (gitleaks error, `scan` returns null), or the scan
 * finds nothing to redact.
 *
 * When `applyRedactions` produces byte-identical output (the finding's `Match`
 * value could not be located in the file, e.g. a truncated/normalized span),
 * emits a no-op warning on the warning channel (`warn`) before writing, so the
 * operator is not misled by a silent "success"; the push re-scan still blocks a
 * leak that slipped through.
 *
 * No live-session mtime guard: unlike a session transcript, a memory file is
 * not actively appended to by a running Claude Code session, so the
 * recently-modified heuristic used for `.jsonl` redaction does not apply here.
 *
 * @param f Trigger finding (used for logical/relPath extraction).
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param map Parsed path-map for the host-mapping lookup.
 * @param scan Injectable scan function for the local re-scan (default `scanFile`).
 * @returns True when the redaction was applied; false when refused or failed.
 */
export function applyMemoryRedact(
  f: Finding,
  ts: string,
  map: PathMap,
  scan: (p: string) => Finding[] | null = scanFile,
): boolean {
  const refuse = (msg: string): false => {
    log(msg);
    return false;
  };

  const parsed = memoryFileFromFinding(f);
  if (parsed === null) {
    return refuse('could not parse this finding as a project-level memory file; choose Skip.');
  }
  const { logical, relPath } = parsed;

  const localPath = resolveMemoryLocalPath(logical, relPath, map);
  if (localPath === null) {
    return refuse(
      `could not locate the local memory file for ${logical}/memory/${relPath}; choose Skip.`,
    );
  }

  const findings = scan(localPath);
  if (findings === null) {
    return refuse(`re-scan of ${logical}/memory/${relPath} failed; choose Skip.`);
  }
  if (findings.length === 0) {
    return refuse(`nothing to redact in ${logical}/memory/${relPath}; choose Skip.`);
  }

  backupBeforeWrite(localPath, ts);
  const before = readFileSync(localPath, 'utf8');
  const after = applyRedactions(before, findings);
  // applyRedactions locates secrets by their `Match` value, not by column. If a
  // finding's Match cannot be found in the file (a truncated or normalized span
  // from the scanner), the file is unchanged despite a non-empty scan, so a
  // silent "redacted" return would mislead the operator into thinking Redact
  // worked. Surface it, mirroring the session-subtree path
  // (`commands.redact.subtree.ts`); the staged-tree re-scan still blocks a real
  // leak that slipped through.
  if (after === before) {
    warn(
      `no redaction applied to ${logical}/memory/${relPath}: finding match values were not ` +
        `located in the file. Inspect it manually; the push re-scan still blocks a real leak.`,
    );
  }
  writeFileSync(localPath, after, 'utf8');

  const dest = join(repoHome(), 'shared', 'projects', logical, 'memory', ...relPath.split('/'));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(localPath, dest, { force: true });

  return true;
}
