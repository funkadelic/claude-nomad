/**
 * Project-level memory-file resolution and redaction for the push-time
 * recovery menu. `memory/*.md` is a PROJECT-LEVEL sibling of every session's
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
 * Not wired into the recovery loop's dispatch/menu yet; that lands in a
 * later plan.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PathMap } from './config.ts';
import { claudeHome, HOST, repoHome } from './config.ts';
import { assertSafeLogical } from './config.sharedDirs.guard.ts';
import { applyRedactions } from './commands.redact.core.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';
import { log } from './utils.ts';

/**
 * Matches a repo-relative POSIX finding path of the form
 * `shared/projects/<logical>/memory/<filename>.md`. The filename group
 * (`[^/]+`) forbids further path separators, so a nested `memory/sub/a.md`
 * does not match (the real, empirically-observed layout has `memory/` as a
 * flat, single-level directory).
 */
const MEMORY_FINDING_PATH = /^shared\/projects\/([^/]+)\/memory\/([^/]+\.md)$/;

/** Filename shape allowed once extracted: no path separators, `.md` suffix. */
const SAFE_MEMORY_FILENAME = /^[^/\\]+\.md$/;

/**
 * Matches any finding under a project-level `memory/` directory, whether the
 * redactable flat `memory/<file>.md` shape or a nested `memory/<subdir>/...`
 * path. Broader than `MEMORY_FINDING_PATH` on purpose.
 */
const MEMORY_DIR_PATH = /^shared\/projects\/[^/]+\/memory\//;

/**
 * Parse a gitleaks finding's `File` path into a project-level memory-file
 * reference. Pure. Returns null for a non-memory path, a nested
 * `memory/<subdir>/x.md` path, or a non-`.md` file.
 *
 * @param f The gitleaks finding.
 * @returns `{logical, filename}` on a match, else null.
 */
export function memoryFileFromFinding(f: Finding): { logical: string; filename: string } | null {
  const m = MEMORY_FINDING_PATH.exec(f.File);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { logical: m[1], filename: m[2] };
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
 * Resolve a memory finding's `{logical, filename}` to the live local path
 * `~/.claude/projects/<encoded>/memory/<filename>`. `assertSafeLogical`
 * guards the `logical` segment (throws `NomadFatal` on `..`/separator) before
 * any join. `filename` is independently guarded against `SAFE_MEMORY_FILENAME`
 * (no path separators, `.md` suffix) and rejected on `..`; a poisoned
 * filename fails closed with a null return rather than a join. Direct lookup
 * (no reverse search): the finding path already names the exact `logical`.
 *
 * @param logical Project logical name extracted from the finding.
 * @param filename Memory filename extracted from the finding.
 * @param map Parsed path-map for the host-mapping lookup.
 * @returns The absolute local path when the host mapping exists and the file
 *   is present on disk, else null.
 */
export function resolveMemoryLocalPath(
  logical: string,
  filename: string,
  map: PathMap,
): string | null {
  assertSafeLogical(logical);
  if (!SAFE_MEMORY_FILENAME.test(filename) || filename.includes('..')) return null;
  const abs = map.projects[logical]?.[HOST];
  if (abs === undefined) return null;
  const localPath = join(claudeHome(), 'projects', encodePath(abs), 'memory', filename);
  return existsSync(localPath) ? localPath : null;
}

/**
 * No-scan, no-mutation redactability preflight for one finding, parallel to
 * `preflightRedactable` in `commands.push.recovery.redact.ts`. Returns a
 * human-readable refusal reason when the finding is not a memory file or the
 * local file cannot be resolved (unmapped host, missing file), else null.
 * Intended for `--redact-all`'s all-or-nothing gate (wired in a later plan).
 *
 * @param f Finding to preflight.
 * @param map Parsed path-map for the host-mapping lookup.
 * @returns A refusal reason string, or null when the finding would proceed.
 */
export function preflightMemoryRedactable(f: Finding, map: PathMap): string | null {
  const parsed = memoryFileFromFinding(f);
  if (parsed === null) return 'a finding is not a project-level memory file';
  const localPath = resolveMemoryLocalPath(parsed.logical, parsed.filename, map);
  if (localPath === null) {
    return `memory file ${parsed.logical}/memory/${parsed.filename}: local file not found or unmapped`;
  }
  return null;
}

/**
 * Apply the Redact action for one project-level memory finding. Resolves the
 * local file, re-scans it via `scan` (default `scanFile`, no `--redact`, so
 * `Finding.Match` carries the real secret value), and on a non-empty scan:
 * backs up the local file (`backupBeforeWrite`), rewrites it in place via the
 * shared `applyRedactions`, then copies the scrubbed file to the staged
 * `shared/projects/<logical>/memory/<filename>`. Returns false (with a logged
 * refusal, never the raw secret) when the finding cannot be resolved, the
 * scan itself fails (gitleaks error, `scan` returns null), or the scan finds
 * nothing to redact.
 *
 * No live-session mtime guard: unlike a session transcript, a memory file is
 * not actively appended to by a running Claude Code session, so the
 * recently-modified heuristic used for `.jsonl` redaction does not apply here.
 *
 * @param f Trigger finding (used for logical/filename extraction).
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
  const { logical, filename } = parsed;

  const localPath = resolveMemoryLocalPath(logical, filename, map);
  if (localPath === null) {
    return refuse(
      `could not locate the local memory file for ${logical}/memory/${filename}; choose Skip.`,
    );
  }

  const findings = scan(localPath);
  if (findings === null) {
    return refuse(`re-scan of ${logical}/memory/${filename} failed; choose Skip.`);
  }
  if (findings.length === 0) {
    return refuse(`nothing to redact in ${logical}/memory/${filename}; choose Skip.`);
  }

  backupBeforeWrite(localPath, ts);
  const before = readFileSync(localPath, 'utf8');
  const after = applyRedactions(before, findings);
  writeFileSync(localPath, after, 'utf8');

  const stagedMemoryDir = join(repoHome(), 'shared', 'projects', logical, 'memory');
  mkdirSync(stagedMemoryDir, { recursive: true });
  cpSync(localPath, join(stagedMemoryDir, filename), { force: true });

  return true;
}
