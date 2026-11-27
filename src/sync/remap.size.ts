import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_SESSION_FILE_BYTES } from '../core/config.ts';
import { warn } from '../core/utils.ts';
import { escapeUnsafe } from './settings-classify.ts';

/** Bytes to whole MiB, rounded up so an over-cap size never prints equal to the limit. */
export const mib = (n: number): number => Math.ceil(n / (1024 * 1024));

/**
 * `true` when `srcPath` is a regular file over `cap` bytes; `skipOversize`
 * without the warning, for dry-run listings.
 */
export function isOversize(srcPath: string, cap = MAX_SESSION_FILE_BYTES): boolean {
  const st = lstatSync(srcPath);
  return st.isFile() && st.size > cap;
}

/**
 * Warn and return `true` when `srcPath` is a regular file over `cap` bytes, so
 * the caller leaves it out of the sync repo. Symlinks and directories are never
 * skipped. `cap` is overridable for tests.
 *
 * @param srcPath - Absolute path of the local file, shown in the warning.
 * @param cap - Per-file byte limit.
 */
export function skipOversize(srcPath: string, cap = MAX_SESSION_FILE_BYTES): boolean {
  if (!isOversize(srcPath, cap)) return false;
  const st = lstatSync(srcPath);
  warn(
    `not syncing ${escapeUnsafe(srcPath)} (${mib(st.size)} MiB): GitHub rejects files over ${mib(cap)} MiB, so it stays on this machine`,
  );
  return true;
}

/**
 * `true` when some non-directory entry under `root` satisfies `pred`. Never
 * descends into a symlink, matching `cpSync`, which copies a link as-is.
 */
function someEntry(root: string, pred: (path: string, atRoot: boolean) => boolean): boolean {
  const walk = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : pred(p, dir === root);
    });
  return walk(root);
}

/**
 * `true` when `dir` holds at least one non-directory entry at any depth, or is
 * itself something other than a directory (a mirror replaces it, which is a
 * change). `false` when it is absent.
 *
 * @param dir - Directory to inspect.
 */
export function hasAnyFile(dir: string): boolean {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) return false;
  return !st.isDirectory() || someEntry(dir, () => true);
}

/**
 * `true` when `copyDirJsonlOnly(src, ...)` would stage at least one entry, with
 * its filter applied in the same order: under the cap, then anything below the
 * root, a root entry that stats as a directory (a symlinked dir is copied as a
 * link), or a root `*.jsonl`. Keep in step with `copyDirJsonlOnly`.
 *
 * @param src - Local project dir.
 * @param cap - Per-file byte limit.
 */
export function mirrorWouldStage(src: string, cap = MAX_SESSION_FILE_BYTES): boolean {
  return someEntry(
    src,
    (p, atRoot) =>
      !isOversize(p, cap) && (!atRoot || statSync(p).isDirectory() || p.endsWith('.jsonl')),
  );
}
