/**
 * Denied-path revert backstop for the pre-pull reconcile: split out of
 * `links.mirror.ts` so the sweep lives beside itself, as the second layer
 * behind `mirrorOneSharedName`'s copy-time filter.
 */

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { deniedSegmentFor } from '../core/config.ts';
import { errorText } from '../core/error-text.ts';
import { gitProbe } from '../core/git-probe.ts';
import { warn } from '../core/utils.ts';
import { backupRepoWrite } from '../core/utils.fs.ts';

/** `git status` snapshot {@link revertDeniedMirrorPaths} acts on; module-private since both call sites pass an object literal. */
type DeniedRevertStatus = {
  /** Repo-relative tracked paths, including both halves of a rename. */
  tracked: readonly string[];
  /** Repo-relative untracked paths. */
  untracked: readonly string[];
};

/**
 * Whether something occupies `abs`, via `lstat` (not `existsSync`, which
 * resolves through a dangling symlink and misses it). Unstat-able reports
 * present so the caller attempts removal rather than guessing.
 */
function presentAt(abs: string): boolean {
  try {
    return lstatSync(abs, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/**
 * Removes an untracked denylisted path after snapshotting it into the pull
 * backup cache; git never had the path, so nothing else can recover it if
 * this step fails unbacked. Recursive: an untracked nested repo arrives as
 * one status record.
 */
function removeUntrackedDenied(repo: string, path: string, segment: string, ts: string): void {
  const abs = join(repo, path);
  const denied = `the path segment "${segment}" is on the never-sync list`;
  if (!presentAt(abs)) {
    warn(
      `nothing was removed for ${path}: ${denied}, but nothing is at that path now. Either it went away after git listed it, in which case there is nothing left to do, or its name did not survive the decode of git's output and the real file is still in the sync repo under a name nomad cannot address. Look for it in ${repo} with "git status --untracked-files=all -- shared/"`,
    );
    return;
  }
  // Read before anything is written: answers whether a copy will exist to
  // name afterwards, distinct from `presentAt` (a dangling symlink is present
  // and uncopyable at once).
  const snapshotted = existsSync(abs);
  try {
    backupRepoWrite(abs, ts, repo);
  } catch (err) {
    warn(
      `could not snapshot ${abs} before removing it (${errorText(err)}), so it was left in place: ${denied}, so remove it by hand`,
    );
    return;
  }
  try {
    rmSync(abs, { recursive: true, force: true });
    if (presentAt(abs)) {
      warn(`could not remove ${abs}: ${denied}, so remove it by hand`);
      return;
    }
    const where = snapshotted ? `. A copy was snapshotted under backup/${ts}/repo/ first` : '';
    warn(`removed ${path} from the sync repo working tree: ${denied}${where}`);
  } catch (err) {
    warn(`could not remove ${abs}: ${errorText(err)}`);
  }
}

/**
 * Reports (never mutates) a denylisted path git already tracks: reconstructing
 * git's index state from a status prefix risks staging a deletion of committed
 * content, so this only names the fix (`git rm --cached` for a staged-only
 * path, `git checkout HEAD --` for one committed) via `git ls-tree HEAD`.
 */
function reportTrackedDenied(repo: string, path: string, segment: string): void {
  const inHead = gitProbe(['ls-tree', '--name-only', 'HEAD', '--', path], repo);
  const denied = `the path segment "${segment}" is on the never-sync list`;
  if (inHead === null) {
    warn(
      `could not check ${path} against HEAD: ${denied}. Nothing was changed. Inspect it by running git status -- "${path}" and take it out of shared/ before committing`,
    );
    return;
  }
  if (inHead.trim() === '') {
    warn(
      `${path} is staged and has no committed version: ${denied}. Nothing was changed. Run git rm --cached -- "${path}" to take it out of the index; that leaves the file on disk but makes it untracked, which the next nomad pull removes from the sync repo working tree (snapshotting it into the backup cache first), so move it outside shared/ instead if you want to keep it. If it is the destination half of a staged rename, run git diff --cached --name-status to name the source, whose content IS committed, so restore that half with git checkout HEAD -- "<source>" rather than leaving its deletion staged`,
    );
    return;
  }
  if (!existsSync(join(repo, path))) return;
  warn(
    `${path} is tracked and has changes against HEAD: ${denied}. Nothing was changed. Run git checkout HEAD -- "${path}" to put the committed content back, or move the file outside shared/ if you want to keep it. Neither of those takes the committed copy out of the repo: git rm -- "${path}" and a commit does that going forward, and if it holds a real secret, rotate it and rewrite history, because nomad only changes your local worktree and index and cannot scrub what a previous push already sent to the remote`,
  );
}

/**
 * Sweeps the repo working tree for denylisted paths: untracked hits are
 * snapshotted and removed, tracked hits are reported only. Never throws;
 * the caller proceeds into the rebase either way. `ts` is the backup
 * timestamp, used only by the untracked (write) half.
 */
export function revertDeniedMirrorPaths(
  repo: string,
  status: DeniedRevertStatus,
  ts: string,
): void {
  for (const path of new Set(status.untracked)) {
    const segment = deniedSegmentFor(path);
    if (segment !== null) removeUntrackedDenied(repo, path, segment, ts);
  }
  for (const path of new Set(status.tracked)) {
    const segment = deniedSegmentFor(path);
    if (segment !== null) reportTrackedDenied(repo, path, segment);
  }
}
