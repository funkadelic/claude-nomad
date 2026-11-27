import { cpSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { renameAtomicRetry } from '../core/utils.fs.ts';
import { type ManifestDiff } from './manifest.ts';
import { skipOversize } from './remap.size.ts';

/**
 * Walk each component from `repoDst` down to `dirname(dst)` with lstat only, so a
 * symlink below `repoDst` never redirects a write or removal out of the repo.
 * With `replace`, a symlink, file or gap in the way becomes a real directory (as
 * the full mirror would leave it); without it, the walk stops and touches nothing.
 *
 * @param repoDst - Absolute path of `shared/projects/<logical>/`.
 * @param dst - Absolute destination path under `repoDst`.
 * @param replace - Whether to replace a non-directory component instead of stopping.
 * @returns `true` when every component is now a real directory.
 */
function prepareDestination(repoDst: string, dst: string, replace: boolean): boolean {
  let dir = repoDst;
  for (const part of ['', ...relative(repoDst, dirname(dst)).split(sep)]) {
    dir = join(dir, part);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) continue;
    if (!replace) return false;
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
  }
  return true;
}

/**
 * Remove `dst` (a symlink, dangling or not, or a whole directory) without
 * following a symlinked ancestor. Returns 1 when something was removed, else 0.
 */
function removeIfPresent(repoDst: string, dst: string): number {
  if (!prepareDestination(repoDst, dst, false)) return 0;
  if (lstatSync(dst, { throwIfNoEntry: false }) === undefined) return 0;
  rmSync(dst, { recursive: true });
  return 1;
}

/**
 * Per-file atomic copy. Makes the path from `repoDst` to the parent of `dst` real
 * directories (see `prepareDestination`), clears a directory left at `dst`, copies
 * `src` to a sibling temp file (`<dst>.tmp.<pid>`), then renames over `dst`. A
 * symlink at `dst` is replaced by the rename, never written through. The
 * rename is atomic on the same filesystem (no EXDEV), so an interrupt leaves
 * either the old file or the new file intact, never a partial write. Unchanged
 * siblings are untouched, keeping their inode and mtime for git's stat-cache.
 *
 * @param src - Absolute source file path.
 * @param dst - Absolute destination file path.
 * @param repoDst - Repo-side project root containing `dst`; nothing at or below it is followed.
 */
export function copyFileAtomic(src: string, dst: string, repoDst: string): void {
  prepareDestination(repoDst, dst, true);
  if (lstatSync(dst, { throwIfNoEntry: false })?.isDirectory() === true) {
    rmSync(dst, { recursive: true });
  }
  const tmp = `${dst}.tmp.${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { force: true, preserveTimestamps: true });
  renameAtomicRetry(tmp, dst);
}

/**
 * Return `true` when `sel` contains any changed or deleted files whose
 * absolute source path starts with `localDir + sep`. Used to skip a project
 * dir that has no delta entries, avoiding a spurious `backupRepoWrite` call
 * for fully unchanged projects.
 */
function hasDeltaForDir(sel: ManifestDiff, localDir: string): boolean {
  const prefix = `${localDir}${sep}`;
  const underDir = (p: string): boolean => p.startsWith(prefix);
  return [...sel.changed].some(underDir) || sel.deleted.some(underDir);
}

/**
 * Return `true` when a selective push has a `selection` that contains no
 * changed or deleted files for `localDir`, meaning the dir can be skipped.
 * Extracted to keep `remapPush` under the cognitive-complexity gate.
 */
export function skipForSelection(sel: ManifestDiff | undefined, localDir: string): boolean {
  return sel !== undefined && !hasDeltaForDir(sel, localDir);
}

/**
 * Apply a manifest delta to a single project dir pair. Copies each changed
 * file into `repoDst` via `copyFileAtomic`; removes repo-side copies of
 * deleted source files and of over-cap files (as a full mirror would). Skips
 * files outside `localDir`. Unchanged files are never opened, so their
 * destination inode and mtime are preserved.
 *
 * @param sel - Manifest diff from `diffManifest`.
 * @param localDir - Absolute path of `~/.claude/projects/<encoded>/`.
 * @param repoDst - Absolute path of `shared/projects/<logical>/`.
 * @param cap - Per-file byte limit; larger changed files are skipped with a warning.
 * @returns How many repo-side files were written or removed.
 */
export function applySelective(
  sel: ManifestDiff,
  localDir: string,
  repoDst: string,
  cap?: number,
): number {
  const prefix = `${localDir}${sep}`;
  let changed = 0;
  // Deletions first, so a file/directory flip clears the old entry before the new one is written.
  for (const src of sel.deleted) {
    if (src.startsWith(prefix)) {
      changed += removeIfPresent(repoDst, join(repoDst, relative(localDir, src)));
    }
  }
  for (const src of sel.changed) {
    if (!src.startsWith(prefix)) continue;
    const dst = join(repoDst, relative(localDir, src));
    if (skipOversize(src, cap)) {
      changed += removeIfPresent(repoDst, dst);
      continue;
    }
    copyFileAtomic(src, dst, repoDst);
    changed++;
  }
  return changed;
}
