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
