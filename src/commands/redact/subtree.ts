/**
 * Pure helpers for enumerating and inspecting a session's live subtree.
 * These functions contain no I/O side effects beyond reading the filesystem
 * (lstatSync, readdirSync, existsSync, statSync) and accept injectable
 * dependencies for testability.
 *
 * The exported helpers span the WHOLE staged subtree (main `<sid>.jsonl` plus
 * every file under `<sid>/`) so enumeration scope equals push-staging scope,
 * eliminating the asymmetry that let secrets in `tool-results/*.txt` (and
 * other non-`agent-*.jsonl` files) bypass redaction.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { applyRedactions, isRecentlyModified } from './core.ts';
import type { ScanFn } from '../push/gitleaks.scan.ts';
import { backupBeforeWrite } from '../../core/utils.fs.ts';
import { log } from '../../core/utils.ts';

/**
 * Recurse into `dir` and collect absolute paths of every regular file,
 * skipping symlinks (to avoid following links out of the subtree). Returns
 * without adding entries when `dir` does not exist.
 *
 * @param dir Absolute path to the directory to walk.
 * @param out Accumulator (mutated in place; callers pass `[]`).
 */
function collectFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) {
      collectFiles(abs, out);
      continue;
    }
    // Must be a regular file after filtering out symlinks and directories.
    // Special entries (sockets, FIFOs, devices) are excluded by the isFile guard.
    /* c8 ignore start */
    if (lst.isFile()) out.push(abs);
    /* c8 ignore stop */
  }
}

/**
 * Return the absolute paths of every regular file under `sessionDir`,
 * recursing into all subdirectories (subagents/, tool-results/, memory/,
 * etc.). Symlinks are skipped to prevent traversal out of the subtree.
 * Returns `[]` when `sessionDir` does not exist or is not a directory.
 *
 * Mirrors the `existsSync + lstatSync` guard shape used by `collectMatches`
 * in `commands.drop-session.ts`. The enumeration scope intentionally matches
 * what `copyDirJsonlOnly` in `remap.ts` stages: all files under a session
 * subdirectory, without extension filtering.
 *
 * @param sessionDir Absolute path to `<encoded>/<sid>` (the session directory,
 *   NOT the `.jsonl` file).
 * @returns Sorted absolute paths of all regular files found in the subtree.
 */
export function listSubtreeFiles(sessionDir: string): string[] {
  const out: string[] = [];
  collectFiles(sessionDir, out);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Return the maximum `mtimeMs` across a session's main transcript and every
 * file in the session subtree. Uses the injected `statMtime` reader so
 * callers can bypass the live filesystem in tests.
 *
 * Guard policy: the live-session guard must key on the NEWEST mtime across
 * the WHOLE staged subtree (main + all subtree files), because any actively-
 * written file under the session directory (subagent jsonl, tool-results txt,
 * metadata json, etc.) should prevent redaction of the entire session.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl` transcript.
 * @param subtreeFiles Absolute paths to every file in the session subtree.
 * @param statMtime Injectable mtime reader; defaults to real `statSync`.
 * @returns The highest mtime in milliseconds found across the whole subtree.
 */
export function newestSubtreeMtimeMs(
  mainPath: string,
  subtreeFiles: string[],
  statMtime: (p: string) => number = (p) => statSync(p).mtimeMs,
): number {
  let newest = statMtime(mainPath);
  for (const filePath of subtreeFiles) {
    const t = statMtime(filePath);
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * True when a session's subtree was modified within the live-session window,
 * keyed on the newest mtime across `mainPath` and every file in `subtreeFiles`.
 *
 * The shared live-session guard for both `nomad redact` and push recovery: each
 * refuses to rewrite a transcript that may still be actively written, because
 * scrubbing a live session races the writer and can corrupt or lose data.
 * Callers pass an already-enumerated `subtreeFiles` list so the subtree is
 * walked once and the guard scope stays equal to the push-staging scope.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl` transcript.
 * @param subtreeFiles Absolute paths of every file under the session subtree.
 * @param now Current time in ms (injectable clock for the recency comparison).
 * @returns True when the newest subtree mtime is within the recent window.
 */
export function isSubtreeActive(mainPath: string, subtreeFiles: string[], now: number): boolean {
  const subtreeMtime = newestSubtreeMtimeMs(mainPath, subtreeFiles, (p) => statSync(p).mtimeMs);
  return isRecentlyModified(subtreeMtime, now);
}

/** A file with at least one finding, ready for redaction. */
export type DirtyFile = {
  /** Absolute path to the file. */
  path: string;
  /** Findings for this file (non-empty). */
  findings: readonly { StartLine: number; Match: string; RuleID: string }[];
};

/** Options for `applySubtreeRedactions`. */
export type SubtreeRedactOptions = {
  /** Optional rule-id filter applied when scanning subtree files. */
  rule?: string;
  /** Backup timestamp for `backupBeforeWrite`. */
  ts: string;
  /** Injectable scan function (without `--redact`). */
  scan: ScanFn;
  /** When true, collect the dirty list but skip all writes. */
  dryRun: boolean;
  /** Repo-relative dir push stages the main file's dir at (`shared/projects/<logical>`). */
  stagedDir?: string;
};

/**
 * Staged path of a subtree file: its path relative to the main transcript's
 * dir, under `stagedDir`. Undefined when the caller passed no staged dir.
 */
function subtreeStagedRel(
  mainPath: string,
  filePath: string,
  stagedDir: string | undefined,
): string | undefined {
  return stagedDir === undefined
    ? undefined
    : join(stagedDir, relative(dirname(mainPath), filePath));
}

/**
 * Scan each subtree file, appending files with (rule-filtered) findings to
 * `dirty`. Returns the files whose scan failed.
 */
function scanSubtreeFiles(
  mainPath: string,
  subtreeFiles: string[],
  opts: SubtreeRedactOptions,
  dirty: DirtyFile[],
): string[] {
  const { rule, scan, stagedDir } = opts;
  const failed: string[] = [];
  for (const filePath of subtreeFiles) {
    const raw = scan(filePath, { stagedRel: subtreeStagedRel(mainPath, filePath, stagedDir) });
    if (raw === null) {
      failed.push(filePath);
      continue;
    }
    const filtered = rule === undefined ? raw : raw.filter((f) => f.RuleID === rule);
    if (filtered.length > 0) dirty.push({ path: filePath, findings: filtered });
  }
  return failed;
}

/**
 * Scan and redact a session subtree (main transcript plus every file under
 * the session directory). The main file's findings are supplied by the caller
 * (already scanned); all subtree files are scanned via `scan`. Backs up and
 * rewrites each dirty file unless `dryRun` is true or any subtree scan failed.
 *
 * This shared helper is the single implementation used by both `applyRedact`
 * (push-time recovery) and `cmdRedact` (standalone `nomad redact`), so any
 * scope fix lands once for both entry points.
 *
 * @param mainPath Absolute path to the main `<sid>.jsonl` transcript.
 * @param mainFindings Pre-resolved findings for the main file (may be empty).
 * @param subtreeFiles Absolute paths to every file in the session subtree
 *   (from `listSubtreeFiles`). These are scanned individually; the main file
 *   must NOT be included here.
 * @param opts Rule filter, backup timestamp, scan seam, dry-run flag and staged dir.
 * @returns `{ total, dirty, failed }`: the finding count across all files, every
 *   file that has (or would have) findings, and every file whose scan failed.
 */
export function applySubtreeRedactions(
  mainPath: string,
  mainFindings: readonly { StartLine: number; Match: string; RuleID: string }[],
  subtreeFiles: string[],
  opts: SubtreeRedactOptions,
): { total: number; dirty: DirtyFile[]; failed: string[] } {
  const { ts, dryRun } = opts;
  const dirty: DirtyFile[] = [];
  if (mainFindings.length > 0) dirty.push({ path: mainPath, findings: mainFindings });
  const failed = scanSubtreeFiles(mainPath, subtreeFiles, opts, dirty);
  const total = dirty.reduce((n, e) => n + e.findings.length, 0);
  // A failed scan may hide a secret, so rewrite nothing and let the caller abort.
  if (!dryRun && total > 0 && failed.length === 0) {
    for (const { path: filePath, findings } of dirty) {
      backupBeforeWrite(filePath, ts);
      const before = readFileSync(filePath, 'utf8');
      const after = applyRedactions(before, findings);
      // applyRedactions locates secrets by their `Match` value, not by column.
      // If a finding's Match cannot be found in the file (e.g. a truncated or
      // normalized span from the scanner), the file is unchanged despite having
      // findings, so a "redacted" report would be misleading. Surface it; the
      // staged-tree re-scan still blocks a real leak that slipped through.
      if (after === before) {
        log(
          `warning: no redaction applied to ${filePath}: finding match values were not located ` +
            `in the file. Inspect it manually; the push re-scan still blocks a real leak.`,
        );
      }
      writeFileSync(filePath, after, 'utf8');
    }
  }
  return { total, dirty, failed };
}
