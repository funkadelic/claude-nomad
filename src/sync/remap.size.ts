import { lstatSync } from 'node:fs';

import { MAX_SESSION_FILE_BYTES } from '../core/config.ts';
import { warn } from '../core/utils.ts';

/** Bytes to whole MiB, rounded up so an over-cap size never prints equal to the limit. */
export const mib = (n: number): number => Math.ceil(n / (1024 * 1024));

/**
 * Warn and return `true` when `srcPath` is a regular file over `cap` bytes, so
 * the caller leaves it out of the sync repo. Symlinks and directories are never
 * skipped. `cap` is overridable for tests.
 *
 * @param srcPath - Absolute path of the local file, shown in the warning.
 * @param cap - Per-file byte limit.
 */
export function skipOversize(srcPath: string, cap = MAX_SESSION_FILE_BYTES): boolean {
  const st = lstatSync(srcPath);
  if (!st.isFile() || st.size <= cap) return false;
  warn(
    `not syncing ${srcPath} (${mib(st.size)} MiB): GitHub rejects files over ${mib(cap)} MiB, so it stays on this machine`,
  );
  return true;
}
