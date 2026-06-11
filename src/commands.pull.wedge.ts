import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The wedge state of a git repository mid-operation.
 *
 * - `'rebase'`: the repo is paused mid-rebase (either the interactive/merge
 *   backend via `.git/rebase-merge`, or the am-backend via `.git/rebase-apply`).
 * - `'merge'`: the repo is paused mid-merge (`.git/MERGE_HEAD` present, no
 *   rebase marker).
 * - `null`: the repo is in a clean state (no in-progress operation).
 *
 * Note: `CHERRY_PICK_HEAD` and `REVERT_HEAD` are intentionally out of scope;
 * nomad never cherry-picks or reverts.
 */
export type WedgeMode = 'rebase' | 'merge' | null;

/**
 * Extended wedge state that includes the unmerged-index-no-active-rebase state.
 *
 * - `'rebase'`: mid-rebase (marker files present).
 * - `'merge'`: mid-merge (`MERGE_HEAD` present, no rebase marker).
 * - `'unmerged-index'`: the index has unmerged stage-2/3 entries but no
 *   active rebase/merge marker. The common post-torn-down-rebase dead end.
 * - `null`: clean state.
 *
 * `WedgeMode` is a strict subset (`'rebase' | 'merge' | null`). The
 * `NonNullable<WedgeMode>` contract in `recoverForceRemote` is unchanged.
 */
export type WedgeState = 'rebase' | 'merge' | 'unmerged-index' | null;

/**
 * Detect whether a git repository is wedged mid-rebase or mid-merge by
 * probing the marker files/dirs in `.git/`. Pure read-only: no git exec, no
 * mutation.
 *
 * Precedence: rebase markers take priority over `MERGE_HEAD` (a repo with
 * both present reports `'rebase'`).
 *
 * @param repo Absolute path to the repository root (where `.git/` lives).
 * @returns `'rebase'` if mid-rebase, `'merge'` if mid-merge, `null` if clean.
 */
export function detectWedge(repo: string): WedgeMode {
  const g = join(repo, '.git');
  if (existsSync(join(g, 'rebase-merge')) || existsSync(join(g, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(g, 'MERGE_HEAD'))) return 'merge';
  return null;
}

/**
 * Probe the git index for unmerged entries (stage-2/3 blobs). Shell-free
 * argv-array invocation mirroring the `gitCapture`/`gitStatusPorcelainZ`
 * convention in `commands.pull.recovery.ts`.
 *
 * Returns `true` when `git diff --diff-filter=U --name-only -z` produces
 * non-empty output (at least one NUL-terminated path), `false` otherwise.
 *
 * @param repo Absolute path to the repository root.
 * @returns `true` if the index contains unmerged entries, `false` if clean.
 */
export function unmergedIndexPresent(repo: string): boolean {
  const raw = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .split('\0')
    .filter(Boolean);
  return raw.length > 0;
}

/**
 * Classify the current wedge state, extending `detectWedge` with the
 * unmerged-index-no-active-rebase case.
 *
 * Precedence (D-1 from Phase 51 locked decisions):
 * 1. If `detectWedge` returns a non-null marker state (`'rebase'` or
 *    `'merge'`), return it verbatim. An active rebase/merge that also has
 *    unmerged index entries is still a marker state.
 * 2. If the index has unmerged entries (`unmergedIndexPresent`), return
 *    `'unmerged-index'`.
 * 3. Otherwise return `null` (clean).
 *
 * `detectWedge` is unchanged (pure file-marker probe, no git exec).
 *
 * @param repo Absolute path to the repository root.
 * @returns The active wedge state, or `null` if the repo is clean.
 */
export function classifyWedge(repo: string): WedgeState {
  const mode = detectWedge(repo);
  if (mode !== null) return mode;
  return unmergedIndexPresent(repo) ? 'unmerged-index' : null;
}

/**
 * Scan `git stash list` for an entry whose subject contains the literal
 * `autostash` token. Returns `true` when such an entry is present.
 *
 * This is a pure presence detector per Phase 51 D-4: it NEVER pops, drops,
 * or otherwise mutates the stash. The match is case-sensitive lowercase,
 * matching how git writes dropped autostash entries
 * (`stash@{N}: On <branch>: autostash`).
 *
 * @param repo Absolute path to the repository root.
 * @returns `true` if any stash entry subject contains `autostash`, else `false`.
 */
export function orphanedAutostashPresent(repo: string): boolean {
  const raw = execFileSync('git', ['stash', 'list'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return raw.split('\n').some((line) => line.includes('autostash'));
}
