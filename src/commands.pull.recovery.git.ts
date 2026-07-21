/**
 * Shared git primitives for the pull recovery paths.
 *
 * Dependency-free leaf: consumed by both `commands.pull.recovery.ts`
 * (`recoverForceRemote`) and `commands.pull.recovery.unmerged.ts`
 * (`recoverUnmergedIndex`), but imports nothing from either.
 */

import { execFileSync } from 'node:child_process';

import { gitStatusPorcelainZ } from './utils.ts';

/**
 * Capture stdout from a shell-free git invocation. Returns the trimmed output.
 * Mirrors the `gitOrFatal` convention (argv-array, no shell) but returns
 * stdout instead of discarding it.
 *
 * @param args Git arguments (excludes the 'git' binary name itself).
 * @param cwd  Working directory for the git invocation.
 * @returns Trimmed stdout string.
 */
export function gitCapture(args: readonly string[], cwd: string): string {
  return execFileSync('git', args as string[], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .trim();
}

/**
 * Parse raw `git status --porcelain=v1 -z` output into tracked and untracked
 * paths. Pure function (no I/O), split out for testability.
 *
 * Each NUL-terminated record has a 2-char XY status followed by a space and
 * the path. `??` marks untracked files; everything else is tracked.
 *
 * Rename and copy records (XY beginning with `R` or `C`) span TWO
 * NUL-separated fields: the new-name field followed by the old-name field
 * (which carries no XY prefix). Both paths are classified as tracked, and the
 * old-name field is consumed so it is not misread as its own record (which
 * would corrupt the path and could let a renamed synced-config path evade the
 * safety gate).
 *
 * @param raw Raw stdout from `git status --porcelain=v1 -z`.
 * @returns Object with `tracked` and `untracked` path arrays.
 */
export function parsePorcelainZ(raw: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  if (!raw) return { tracked, untracked };
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 3) continue;
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    if (xy === '??') {
      untracked.push(filePath);
      continue;
    }
    tracked.push(filePath);
    if (xy.startsWith('R') || xy.startsWith('C')) {
      const src = records[i + 1];
      if (src) {
        tracked.push(src);
        i++;
      }
    }
  }
  return { tracked, untracked };
}

/**
 * Read and parse the repo's dirty working-tree state via porcelain `-z`.
 *
 * @param repo Absolute path to the repository root.
 * @param opts.untrackedAll When `true`, list every file inside a wholly
 *   untracked directory instead of collapsing it to a single `dir/` entry.
 *   Needed whenever the caller matches on exact paths; the default collapsed
 *   form is kept for callers that only prefix-match.
 * @returns Object with `tracked` and `untracked` path arrays.
 */
export function parseDirtyPaths(
  repo: string,
  opts: { untrackedAll?: boolean } = {},
): { tracked: string[]; untracked: string[] } {
  return parsePorcelainZ(gitStatusPorcelainZ(repo, opts));
}
