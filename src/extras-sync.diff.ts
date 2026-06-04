import { execFileSync } from 'node:child_process';

import { warn } from './utils.ts';

/**
 * Map one `git diff --no-index --name-status` line to its display string.
 * Splits on the first tab into a status letter and the remainder (the path;
 * the remainder is taken whole so a rename/copy similarity score or a second
 * path cannot truncate it). Status `D` means the file exists in the local
 * (`a`) side only -> `(local only)`; `A` means the repo (`b`) side only ->
 * `(repo only)`; any other status (M and the rename/copy/type-change letters)
 * returns the plain path with no suffix. Never emits `/dev/null`.
 *
 * @param line - A single non-empty `--name-status` output line.
 * @returns The real path, suffixed with a side indicator for one-sided files.
 */
function labelDiffLine(line: string): string {
  const tab = line.indexOf('\t');
  /* c8 ignore start -- every --name-status line is tab-separated; a tabless line cannot occur */
  if (tab === -1) return line;
  /* c8 ignore stop */
  const status = line.slice(0, tab);
  const path = line.slice(tab + 1);
  if (status === 'D') return `${path} (local only)`;
  if (status === 'A') return `${path} (repo only)`;
  return path;
}

/**
 * Split raw `git diff --no-index --name-status` stdout into labelled lines.
 *
 * @param stdout - The captured stdout of the diff invocation.
 * @returns Real diverging paths, one-sided files carrying a side indicator.
 */
function parseDiffOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map(labelDiffLine);
}

/**
 * List files that differ between two paths via `git diff --no-index
 * --name-status`. The name-status flag is used (not the bare name flag)
 * because in `--no-index` mode the bare name flag prints the NEW-side name of
 * each pair, so a file present on one side only collapses to `/dev/null`.
 * `--name-status` instead yields the real path of whichever side holds the
 * file: a local-only file (status `D`) is returned as `<path> (local only)`, a
 * repo-only file (status `A`) as `<path> (repo only)`, and a content
 * modification (status `M`) as the plain path. No returned line is ever
 * `/dev/null`. Exit 0 = identical, exit 1 = differences exist (read names from
 * `e.stdout`, not an error). Missing-git (ENOENT) and other git failures each
 * surface a WARN instead of collapsing to a silent empty list, so the operator
 * can tell "no diff" (silent) apart from a skipped check (the loud-doctor
 * contract). Argv-array `execFileSync` (no shell) so paths cannot inject.
 *
 * @param a - First path to compare (the local side, named in WARN messages).
 * @param b - Second path to compare (the repo side).
 * @returns Real diverging paths with side indicators, or `[]` when identical
 *   or skipped.
 */
export function listDivergingFiles(a: string, b: string): string[] {
  try {
    const stdout = execFileSync('git', ['diff', '--no-index', '--name-status', a, b], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return parseDiffOutput(stdout);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer };
    if (e.status === 1 && e.stdout !== undefined) {
      return parseDiffOutput(e.stdout.toString());
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
