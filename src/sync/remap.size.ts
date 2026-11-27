import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
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

/** `true` when `dir` exists and holds at least one non-directory entry at any depth. */
export function hasAnyFile(dir: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir, { recursive: true, withFileTypes: true }).some((e) => !e.isDirectory())
  );
}

/**
 * `true` when `copyDirJsonlOnly(src, ...)` would stage at least one entry: a
 * non-directory under the cap that is either below the root or a root `*.jsonl`.
 * A root symlink to a directory is copied as a link, so it counts too. Keep in
 * step with `copyDirJsonlOnly`'s filter.
 *
 * @param src - Local project dir.
 * @param cap - Per-file byte limit.
 */
export function mirrorWouldStage(src: string, cap = MAX_SESSION_FILE_BYTES): boolean {
  return readdirSync(src, { recursive: true, withFileTypes: true }).some((e) => {
    if (e.isDirectory()) return false;
    const p = join(e.parentPath, e.name);
    const kept = e.parentPath !== src || e.name.endsWith('.jsonl') || statSync(p).isDirectory();
    return kept && !isOversize(p, cap);
  });
}
