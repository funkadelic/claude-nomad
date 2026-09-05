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
 * is a hard refusal. Committed stranded work is preserved on the parking branch
 * (recoverable there and via git reflog), and untracked files survive the reset
 * entirely. The one discard that is NOT recoverable is an UNCOMMITTED change to a
 * tracked, non-synced-config path (tool-source under `shared/projects/**` or
 * `shared/extras/**`): `git branch <name> HEAD` captures only committed state, so
 * `git reset --hard` drops it. That is acceptable because those trees are
 * regenerable from `~/.claude/` on the next push, but the discard is real, not
 * reversible.
 */

import { PUSH_ALLOWED_STATIC } from '../../config.ts';
import type { WedgeMode } from './wedge.ts';
import { die, gitOrFatal, log } from '../../utils.ts';
import { nowTimestamp } from '../../utils.fs.ts';
import { gitCapture, parseDirtyPaths } from './recovery.git.ts';

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
export function recoverForceRemote(mode: NonNullable<WedgeMode>, repo: string): void {
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
      "force-remote refused: the sync repo's synced config differs from origin/main.\n" +
        'Differing paths:\n' +
        // Quoted for display only: `-z` hands back raw names, and a path
        // carrying a newline or a terminal control sequence would otherwise
        // split or rewrite the recovery steps printed below it. The
        // classification above uses the raw value.
        synced.map((p) => `  ${JSON.stringify(p)}`).join('\n') +
        '\nThe comparison runs both ways, so a path can be listed because origin/main is ahead of\n' +
        'you, with nothing of yours at risk on it.\n' +
        '\nManual recovery. Step 1 is not optional: this refusal happens BEFORE recovery parks your\n' +
        'local commits, so nothing has been saved for you yet and step 3 discards whatever is not\n' +
        'on another ref.\n' +
        '  1. git branch nomad-rescue HEAD   (keeps every local commit)\n' +
        '  2. copy any uncommitted work above OUT of the repo (it exists nowhere else)\n' +
        '  3. git reset --hard origin/main   (this is what clears the refusal)\n' +
        '  4. nomad pull\n\n' +
        'Copying or moving the files alone does not clear it: git still reports a moved file as a\n' +
        'deletion, and a committed change is still ahead of origin/main. The in-progress rebase or\n' +
        "merge has ALREADY been aborted, so re-running 'nomad pull --force-remote' now behaves as\n" +
        'an ordinary pull.\n' +
        '(see FAQ: "Every pull fails with unmerged files")',
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
