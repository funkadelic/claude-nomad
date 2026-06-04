/**
 * Recovery orchestrator for `nomad pull --force-remote`.
 *
 * Automates the manual recovery sequence documented in the FAQ:
 *   1. Abort the in-progress rebase or merge.
 *   2. Fetch origin/main and verify the ref exists.
 *   3. Safety diff: collect paths touched by stranded commits AND dirty tracked
 *      changes; refuse (listing at-risk paths) if any touch synced config.
 *   4. Park stranded commits on `nomad/stranded-<ts>` BEFORE resetting.
 *   5. Reset hard to origin/main; control returns to cmdPull for the re-pull.
 *
 * The single safety gate: any touch of a synced-config path (PUSH_ALLOWED_STATIC)
 * is a hard refusal; every other discard is reversible via the parking branch
 * (and git reflog as a further backstop).
 */

import { execFileSync } from 'node:child_process';

import { PUSH_ALLOWED_STATIC } from './config.ts';
import { type WedgeMode } from './commands.pull.wedge.ts';
import { die, gitOrFatal, gitStatusPorcelainZ, log } from './utils.ts';
import { nowTimestamp } from './utils.fs.ts';

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
  return execFileSync('git', args as string[], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/**
 * Return true when `path` is a synced-config entry (from PUSH_ALLOWED_STATIC).
 * Trailing-slash entries are prefix matches; all others are exact.
 * Example: `shared/agents/foo.md` matches the `shared/agents/` entry, but
 * `shared-evil/x` does NOT match any `shared/` entry.
 *
 * @param path Repo-relative path to test.
 */
function isSyncedConfig(path: string): boolean {
  return PUSH_ALLOWED_STATIC.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );
}

/**
 * Partition a list of touched repo-relative paths into synced-config paths and
 * tool-source paths. Pure function.
 *
 * @param touched List of repo-relative paths to classify.
 * @returns Object with `synced` (at-risk) and `toolSource` (discardable) arrays.
 */
export function classifyTouched(touched: string[]): { synced: string[]; toolSource: string[] } {
  const synced: string[] = [];
  const toolSource: string[] = [];
  for (const p of touched) {
    if (isSyncedConfig(p)) {
      synced.push(p);
    } else {
      toolSource.push(p);
    }
  }
  return { synced, toolSource };
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
 * @returns Object with `tracked` and `untracked` path arrays.
 */
function parseDirtyPaths(repo: string): { tracked: string[]; untracked: string[] } {
  return parsePorcelainZ(gitStatusPorcelainZ(repo));
}

/**
 * Assemble the human-readable recovery summary line. Pure function (no I/O),
 * split out so both the with-stranded-commits and empty-range arms are
 * directly testable.
 *
 * @param branchName  Parking branch the stranded commits were moved to.
 * @param strandedLog Raw `git log --oneline origin/main..<branch>` output.
 * @param untracked   Untracked paths preserved across the reset.
 * @returns The semicolon-joined summary string passed to `log`.
 */
export function buildRecoverySummary(
  branchName: string,
  strandedLog: string,
  untracked: readonly string[],
): string {
  const strandedLines = strandedLog
    .split('\n')
    .filter(Boolean)
    .map((l) => `  ${l}`)
    .join('\n');
  const parts: string[] = [`parked stranded commits on ${branchName}`];
  if (strandedLines) parts.push(`stranded:\n${strandedLines}`);
  if (untracked.length > 0) parts.push(`untracked files preserved: ${untracked.join(', ')}`);
  parts.push('continuing with normal pull');
  return parts.join('; ');
}

/**
 * Pick a parking-branch name that does not already exist. `nowTimestamp()` is
 * second-resolution, so two `--force-remote` recoveries in the same wall-clock
 * second would collide; probe `git rev-parse --verify` on each candidate ref
 * and append a `-N` suffix until one is free. Preserves the fail-closed
 * property (the branch is created before any reset) without the spurious abort.
 *
 * @param repo Absolute path to the repository root.
 * @returns A `nomad/stranded-<ts>[-N]` ref name not currently in use.
 */
export function freshStrandedBranch(repo: string): string {
  const base = `nomad/stranded-${nowTimestamp()}`;
  const exists = (name: string): boolean => {
    try {
      gitCapture(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo);
      return true;
    } catch {
      return false;
    }
  };
  if (!exists(base)) return base;
  let n = 1;
  while (exists(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Recover from a wedged REPO_HOME under `nomad pull --force-remote`.
 *
 * Abort the in-progress rebase or merge, fetch origin/main, run the safety
 * diff, refuse if any synced-config path is touched, otherwise park stranded
 * commits on `nomad/stranded-<ts>` and reset hard to origin/main. Control
 * returns to cmdPull which continues with the normal pull flow.
 *
 * All git ops are shell-free argv-array invocations, forwarding stderr through
 * gitOrFatal. `die()` throws NomadFatal, which the cmdPull catch block handles
 * (lock released in finally).
 *
 * @param mode   Current wedge state ('rebase' or 'merge').
 * @param repo   Absolute path to REPO_HOME.
 */
export function recoverForceRemote(mode: WedgeMode, repo: string): void {
  // Step 1: abort the in-progress operation (must match the verb to the mode).
  if (mode === 'merge') {
    gitOrFatal(['merge', '--abort'], 'git merge --abort', repo);
  } else {
    gitOrFatal(['rebase', '--abort'], 'git rebase --abort', repo);
  }

  // Step 2: fetch origin/main so the ref is current, then verify it exists.
  // gitOrFatal will die if the remote has no 'main' branch; the catch below
  // is a defensive guard for the (unreachable in practice) case where the
  // fetch succeeds but the ref still does not resolve.
  gitOrFatal(['fetch', 'origin', 'main'], 'git fetch origin main', repo);
  /* c8 ignore start */
  try {
    gitCapture(['rev-parse', '--verify', 'origin/main'], repo);
  } catch {
    die('origin/main not found after fetch; check your remote configuration');
  }
  /* c8 ignore stop */

  // Step 3: safety diff.
  // Committed paths: two-arg tree diff gives the literal tree diff
  // (conservative). `-z` is required so non-ASCII paths are emitted raw
  // (NUL-delimited, never quoted/escaped) and match the synced-config prefix.
  const committedRaw = gitCapture(['diff', '--name-only', '-z', 'origin/main', 'HEAD'], repo);
  const committedTouched = committedRaw.split('\0').filter(Boolean);

  // Dirty tracked paths: porcelain -z, exclude untracked entries.
  const { tracked: dirtyTracked, untracked } = parseDirtyPaths(repo);

  const allTouched = [...committedTouched, ...dirtyTracked];
  const { synced } = classifyTouched(allTouched);

  if (synced.length > 0) {
    die(
      'force-remote refused: stranded or dirty tracked changes touch synced config.\n' +
        'At-risk paths:\n' +
        synced.map((p) => `  ${p}`).join('\n') +
        '\nCopy or cherry-pick those changes out before retrying.',
    );
  }

  // Step 4: park stranded commits BEFORE reset (data-safety invariant).
  const branchName = freshStrandedBranch(repo);
  gitOrFatal(['branch', branchName, 'HEAD'], 'park stranded commits', repo);

  // Step 5: reset hard to origin/main.
  gitOrFatal(['reset', '--hard', 'origin/main'], 'reset to origin/main', repo);

  // Log a summary for the user.
  const strandedLog = gitCapture(['log', '--oneline', `origin/main..${branchName}`], repo);
  log(buildRecoverySummary(branchName, strandedLog, untracked));
}
