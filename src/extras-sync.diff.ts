import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

import { warn } from './utils.ts';

/** One parsed `--name-status` line: the status letter and the whole remainder path. */
type DiffEntry = { status: string; path: string };

/**
 * Split raw `git diff --no-index --name-status` stdout into `{ status, path }`
 * entries, dropping empty lines. The remainder after the first tab is taken
 * whole so a rename/copy similarity score or a second path cannot truncate the
 * real path. Shared by `listDivergingFiles` (which labels each entry) and
 * `listDivergingModified` (which keeps the modified-both-sides subset).
 *
 * @param stdout - The captured stdout of the diff invocation.
 * @returns One entry per non-empty diff line, status letter split from path.
 */
function parseNameStatus(stdout: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    /* c8 ignore start -- every --name-status line is tab-separated; a tabless line cannot occur */
    if (tab === -1) continue;
    /* c8 ignore stop */
    entries.push({ status: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  return entries;
}

/**
 * Map one parsed `--name-status` entry to its display string. Status `D` means
 * the file exists in the local (`a`) side only -> `(local only)`; `A` means the
 * repo (`b`) side only -> `(repo only)`; any other status (M and the
 * rename/copy/type-change letters) returns the plain path with no suffix. Never
 * emits `/dev/null`.
 *
 * @param entry - A single parsed name-status entry.
 * @returns The real path, suffixed with a side indicator for one-sided files.
 */
function labelEntry(entry: DiffEntry): string {
  if (entry.status === 'D') return `${entry.path} (local only)`;
  if (entry.status === 'A') return `${entry.path} (repo only)`;
  return entry.path;
}

/**
 * Split raw `git diff --no-index --name-status` stdout into labelled lines.
 *
 * @param stdout - The captured stdout of the diff invocation.
 * @returns Real diverging paths, one-sided files carrying a side indicator.
 */
function parseDiffOutput(stdout: string): string[] {
  return parseNameStatus(stdout).map(labelEntry);
}

/**
 * Keep only the modified-both-sides (status `M`) entries and return their paths
 * RELATIVE to `a`, unlabelled. One-sided files (status `A`/`D`) and
 * rename/copy/type-change entries are excluded, since the guard only preserves a
 * file that exists on BOTH sides with diverging content. The name-status path
 * for an `M` entry is prefixed with the `a` argument as passed to git, so
 * `relative(a, path)` yields the clean root-relative path the copy filter matches
 * against `relative(src, srcEntry)`.
 *
 * @param stdout - The captured stdout of the diff invocation.
 * @param a - The first (local) path passed to git; used to relativize M paths.
 * @returns Root-relative paths of both-sides-modified files, no side suffix.
 */
function parseModifiedPaths(stdout: string, a: string): string[] {
  return parseNameStatus(stdout)
    .filter((entry) => entry.status === 'M')
    .map((entry) => relative(a, entry.path));
}

/**
 * Run `git diff --no-index --name-status a b` and pass its stdout to `parse`.
 * The name-status flag is used (not the bare name flag) because in `--no-index`
 * mode the bare name flag prints the NEW-side name of each pair, so a file
 * present on one side only collapses to `/dev/null`. Exit 0 = identical, exit 1
 * = differences exist (read names from `e.stdout`, not an error). Missing-git
 * (ENOENT) and other git failures each surface a WARN instead of collapsing to a
 * silent empty list, so the operator can tell "no diff" (silent) apart from a
 * skipped check (the loud-doctor contract). Argv-array `execFileSync` (no shell)
 * so paths cannot inject.
 *
 * @param a - First path to compare (the local side, named in WARN messages).
 * @param b - Second path to compare (the repo side).
 * @param parse - Turns the captured stdout into the caller's result shape.
 * @returns The parsed diverging paths, or `[]` when identical or skipped.
 */
function runNameStatusDiff(a: string, b: string, parse: (stdout: string) => string[]): string[] {
  try {
    const stdout = execFileSync('git', ['diff', '--no-index', '--name-status', a, b], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return parse(stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer };
    if (e.status === 1 && e.stdout !== undefined) {
      return parse(e.stdout.toString());
    }
    if (e.code === 'ENOENT') {
      warn(`git not on PATH; divergence check skipped for ${a}`);
      return [];
    }
    /* c8 ignore next -- e.message is set on any thrown Error; String(err) is a defensive fallback */
    warn(`divergence check failed for ${a}: ${e.message ?? String(err)}`);
    return [];
  }
}

/**
 * List files that differ between two paths. A local-only file (status `D`) is
 * returned as `<path> (local only)`, a repo-only file (status `A`) as
 * `<path> (repo only)`, and a content modification (status `M`) as the plain
 * path. No returned line is ever `/dev/null`.
 *
 * @param a - First path to compare (the local side, named in WARN messages).
 * @param b - Second path to compare (the repo side).
 * @returns Real diverging paths with side indicators, or `[]` when identical
 *   or skipped.
 */
export function listDivergingFiles(a: string, b: string): string[] {
  return runNameStatusDiff(a, b, parseDiffOutput);
}

/**
 * List the both-sides-modified (status `M`) files as paths RELATIVE to `a`,
 * unlabelled. This is the diverged-conflict set the `.planning` pull guard
 * (`copyExtrasOverlaySkipDiverged`) consumes: a file present on both sides whose
 * content hash differs is kept local rather than overwritten. Files present on
 * only one side (status `A`/`D`) are excluded, since they are not a both-sides
 * conflict. Divergence is content-level (git compares bytes), never mtime, so a
 * git-checkout mtime rewrite cannot manufacture a false conflict.
 *
 * @param a - Local path (compared first; returned paths are relative to it).
 * @param b - Repo path (compared second).
 * @returns Root-relative paths of both-sides-modified files, or `[]` when
 *   identical or skipped.
 */
export function listDivergingModified(a: string, b: string): string[] {
  return runNameStatusDiff(a, b, (stdout) => parseModifiedPaths(stdout, a));
}
