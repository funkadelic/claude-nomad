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
import { join } from 'node:path';

import { applyRedactions } from './commands.redact.core.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { backupBeforeWrite } from './utils.fs.ts';

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

/** A file with at least one finding, ready for redaction. */
export type DirtyFile = {
  /** Absolute path to the file. */
  path: string;
  /** Findings for this file (non-empty). */
  findings: readonly { StartLine: number; Match: string; RuleID: string }[];
};

/**
 * Scan and redact a session subtree (main transcript plus every file under
 * the session directory). The main file's findings are supplied by the caller
 * (already scanned); all subtree files are scanned via `scan`. Skips files
 * whose scan returns `null` or `[]` without aborting. Backs up and rewrites
 * each dirty file unless `dryRun` is true.
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
 * @param rule Optional rule-id filter applied when scanning subtree files.
 * @param ts Backup timestamp for `backupBeforeWrite`.
 * @param scan Injectable scan function (without `--redact`).
 * @param dryRun When true, collect the dirty list but skip all writes.
 * @returns `{ total, dirty }` where `total` is the finding count across all
 *   files and `dirty` lists every file that has (or would have) findings.
 */
export function applySubtreeRedactions(
  mainPath: string,
  mainFindings: readonly { StartLine: number; Match: string; RuleID: string }[],
  subtreeFiles: string[],
  rule: string | undefined,
  ts: string,
  scan: (p: string) => Finding[] | null,
  dryRun: boolean,
): { total: number; dirty: DirtyFile[] } {
  const dirty: DirtyFile[] = [];
  if (mainFindings.length > 0) dirty.push({ path: mainPath, findings: mainFindings });
  for (const filePath of subtreeFiles) {
    const raw = scan(filePath);
    if (raw === null || raw.length === 0) continue;
    const filtered = rule === undefined ? raw : raw.filter((f) => f.RuleID === rule);
    if (filtered.length === 0) continue;
    dirty.push({ path: filePath, findings: filtered });
  }
  const total = dirty.reduce((n, e) => n + e.findings.length, 0);
  if (!dryRun && total > 0) {
    for (const { path: filePath, findings } of dirty) {
      backupBeforeWrite(filePath, ts);
      writeFileSync(filePath, applyRedactions(readFileSync(filePath, 'utf8'), findings), 'utf8');
    }
  }
  return { total, dirty };
}
