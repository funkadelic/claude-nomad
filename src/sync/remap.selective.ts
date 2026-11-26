import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { renameAtomicRetry } from '../core/utils.fs.ts';
import { type ManifestDiff } from './manifest.ts';
import { skipOversize } from './remap.size.ts';

/** Remove `dst` when present; returns 1 when something was removed, else 0. */
function removeIfPresent(dst: string): number {
  if (!existsSync(dst)) return 0;
  rmSync(dst);
  return 1;
}

/**
 * Per-file atomic copy. Creates the destination parent directory, copies `src`
 * to a sibling temp file (`<dst>.tmp.<pid>`), then renames over `dst`. The
 * rename is atomic on the same filesystem (no EXDEV), so an interrupt leaves
 * either the old file or the new file intact, never a partial write. Unchanged
 * siblings are untouched, keeping their inode and mtime for git's stat-cache.
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
  for (const src of sel.changed) {
    if (!src.startsWith(prefix)) continue;
    const dst = join(repoDst, relative(localDir, src));
    if (skipOversize(src, cap)) {
      changed += removeIfPresent(dst);
      continue;
    }
    copyFileAtomic(src, dst);
    changed++;
  }
  for (const src of sel.deleted) {
    if (src.startsWith(prefix)) changed += removeIfPresent(join(repoDst, relative(localDir, src)));
  }
  return changed;
}
