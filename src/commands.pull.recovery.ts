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
 * Parse `git status --porcelain=v1 -z` output into tracked and untracked paths.
 * Each NUL-terminated record has a 2-char XY status followed by a space and
 * the path. `??` marks untracked files; everything else is tracked.
 *
 * @param repo Absolute path to the repository root.
 * @returns Object with `tracked` and `untracked` path arrays.
 */
function parseDirtyPaths(repo: string): { tracked: string[]; untracked: string[] } {
  const raw = gitStatusPorcelainZ(repo);
  const tracked: string[] = [];
  const untracked: string[] = [];
  if (!raw) return { tracked, untracked };
  const records = raw.split('\0').filter((r) => r.length >= 3);
  for (const record of records) {
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    if (xy === '??') {
      untracked.push(filePath);
    } else {
      tracked.push(filePath);
    }
  }
  return { tracked, untracked };
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
  // Committed paths: two-dot diff gives the literal tree diff (conservative).
  const committedRaw = gitCapture(['diff', '--name-only', 'origin/main', 'HEAD'], repo);
  const committedTouched = committedRaw.split('\n').filter(Boolean);

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
  const branchName = `nomad/stranded-${nowTimestamp()}`;
  gitOrFatal(['branch', branchName, 'HEAD'], 'park stranded commits', repo);

  // Step 5: reset hard to origin/main.
  gitOrFatal(['reset', '--hard', 'origin/main'], 'reset to origin/main', repo);

  // Log a summary for the user.
  const strandedLog = gitCapture(['log', '--oneline', `origin/main..${branchName}`], repo);
  const strandedLines = strandedLog
    .split('\n')
    .filter(Boolean)
    .map((l) => `  ${l}`)
    .join('\n');
  const parts: string[] = [`parked stranded commits on ${branchName}`];
  /* c8 ignore start */
  if (strandedLines) parts.push(`stranded:\n${strandedLines}`);
  /* c8 ignore stop */
  if (untracked.length > 0) parts.push(`untracked files preserved: ${untracked.join(', ')}`);
  parts.push('continuing with normal pull');
  log(parts.join('; '));
}
