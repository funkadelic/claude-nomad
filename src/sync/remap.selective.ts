import { cpSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { renameAtomicRetry } from '../core/utils.fs.ts';
import { type ManifestDiff } from './manifest.ts';
import { skipOversize } from './remap.size.ts';

/**
 * Map a local source path under `localDir` to its repo-side counterpart, or
 * `undefined` when it is not under `localDir` or resolves outside it (a `..`
 * key from a corrupt manifest), so nothing is written or removed outside `repoDst`.
 */
function repoPath(localDir: string, repoDst: string, src: string): string | undefined {
  const rel = relative(localDir, src);
  return src.startsWith(`${localDir}${sep}`) && rel.split(sep)[0] !== '..'
    ? join(repoDst, rel)
    : undefined;
}

/**
 * `true` when a per-file copy to `dst` would have to go through something other
 * than real directories: a symlink or file at or below `repoDst` on the way to
 * `dst`, or a directory at `dst` itself. Missing components are fine.
 */
function isObstructed(repoDst: string, dst: string): boolean {
  let dir = repoDst;
  for (const part of relative(repoDst, dst).split(sep)) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st === undefined) return false;
    if (!st.isDirectory()) return true;
    dir = join(dir, part);
  }
  return lstatSync(dst, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * `true` when any delta entry for `localDir` is obstructed (see `isObstructed`),
 * so the project must go through the full mirror instead. The mirror replaces
 * symlinks and file/directory flips wholesale, keeping the repo identical to a
 * cold-start push.
 *
 * @param sel - Manifest diff from `diffManifest`.
 * @param localDir - Absolute path of `~/.claude/projects/<encoded>/`.
 * @param repoDst - Absolute path of `shared/projects/<logical>/`.
 */
export function selectionNeedsMirror(
  sel: ManifestDiff,
  localDir: string,
  repoDst: string,
): boolean {
  return [...sel.changed, ...sel.deleted].some((src) => {
    const dst = repoPath(localDir, repoDst, src);
    return dst !== undefined && isObstructed(repoDst, dst);
  });
}

/** Remove `dst` (a dangling symlink included); returns 1 when something was removed, else 0. */
function removeIfPresent(dst: string): number {
  if (lstatSync(dst, { throwIfNoEntry: false }) === undefined) return 0;
  rmSync(dst);
  return 1;
}

/**
 * Per-file atomic copy. Creates the destination parent directory, copies `src`
 * to a sibling temp file (`<dst>.tmp.<pid>`), then renames over `dst`. The
 * rename is atomic on the same filesystem (no EXDEV), so an interrupt leaves
 * either the old file or the new file intact, never a partial write. Unchanged
 * siblings are untouched, keeping their inode and mtime for git's stat-cache.
 * Callers rule out a symlinked ancestor first (`selectionNeedsMirror`).
 *
 * @param src - Absolute source file path.
 * @param dst - Absolute destination file path.
 */
export function copyFileAtomic(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp.${process.pid}`;
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
 * files outside `localDir` and keys that resolve outside it. Callers route an
 * obstructed project (`selectionNeedsMirror`) to the full mirror first.
 * Unchanged files are never opened, so their destination inode and mtime are
 * preserved.
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
  const target = (src: string): string | undefined => repoPath(localDir, repoDst, src);
  let changed = 0;
  for (const src of sel.changed) {
    const dst = target(src);
    if (dst === undefined) continue;
    if (skipOversize(src, cap)) {
      changed += removeIfPresent(dst);
      continue;
    }
    copyFileAtomic(src, dst);
    changed++;
  }
  for (const src of sel.deleted) {
    const dst = target(src);
    if (dst !== undefined) changed += removeIfPresent(dst);
  }
  return changed;
}
