import { execFileSync } from 'node:child_process';

import { warn } from './utils.ts';

/**
 * List files that differ between two paths via `git diff --no-index
 * --name-only`. Exit 0 = identical, exit 1 = differences exist (read names
 * from `e.stdout`, not an error). Missing-git (ENOENT) and other git failures
 * each surface a WARN instead of collapsing to a silent empty list, so the
 * operator can tell "no diff" (silent) apart from a skipped check (the
 * loud-doctor contract). Argv-array `execFileSync` (no shell) so paths cannot
 * inject.
 *
 * @param a - First path to compare (the local side, named in WARN messages).
 * @param b - Second path to compare (the repo side).
 * @returns Relative file paths that differ, or `[]` when identical or skipped.
 */
export function listDivergingFiles(a: string, b: string): string[] {
  try {
    const stdout = execFileSync('git', ['diff', '--no-index', '--name-only', a, b], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return stdout.split('\n').filter((line) => line.length > 0);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer };
    if (e.status === 1 && e.stdout !== undefined) {
      return e.stdout
        .toString()
        .split('\n')
        .filter((line) => line.length > 0);
    }
    if (e.code === 'ENOENT') {
      warn(`git not on PATH; divergence check skipped for ${a}`);
      return [];
    }
    warn(`divergence check failed for ${a}: ${e.message ?? String(err)}`);
    return [];
  }
}
