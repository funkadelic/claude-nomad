import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { NomadFatal } from './utils.ts';

/**
 * Wrap a path in double quotes for a user-facing message, WITHOUT
 * JSON-escaping. `JSON.stringify` doubles every backslash, so on win32 the
 * quoted path no longer contains the real path as a substring, breaking any
 * caller (or test) that greps the message for the raw path.
 */
function quoted(p: string): string {
  return `"${p}"`;
}

/**
 * Pull-side hardening shared by every overlay/preserving copy. Recursively
 * removes any dst entry that is a symlink and collides with a non-excluded
 * `src` entry, so the follow-up `cpSync({ force: true, verbatimSymlinks: true })`
 * creates a fresh node instead of writing THROUGH the pre-existing link to a
 * target outside the project tree. Without it a poisoned repo can (1) ship a
 * benignly-named symlink that `verbatimSymlinks` copies verbatim into dst, then
 * (2) on a later pull replace that name with a regular file or directory whose
 * content is written through the surviving dst link to an arbitrary path
 * (`~/.ssh/authorized_keys`, `~/.bashrc`, a denylisted per-host file). Only
 * symlinks are removed, so real dst-only files survive (overlay semantics);
 * real dst directories are recursed into to catch nested links. `isExcluded`
 * mirrors the caller's `cpSync` filter so the walk matches what will actually
 * be written. A non-existent dst (fresh pull) is a no-op.
 *
 * Exported so `remap.ts` can reuse it for the pull-side session overlay
 * (`overlaySessionDir`): the session retain-merge needs the same
 * symlink-poisoning guard before its `cpSync`, and this is the single source of
 * truth for that guard (never lifted or duplicated).
 *
 * @param src - Source directory (repo side on pull).
 * @param dst - Destination directory (host side on pull).
 * @param isExcluded - Returns `true` for a basename the copy filter skips.
 */
export function stripCollidingDstSymlinks(
  src: string,
  dst: string,
  isExcluded: (name: string) => boolean,
): void {
  if (!existsSync(dst)) return;
  for (const name of readdirSync(src)) {
    if (isExcluded(name)) continue;
    const dstPath = join(dst, name);
    const dstStat = lstatSync(dstPath, { throwIfNoEntry: false });
    if (dstStat === undefined) continue;
    if (dstStat.isSymbolicLink()) {
      rmSync(dstPath, { recursive: true, force: true });
    } else if (dstStat.isDirectory() && lstatSync(join(src, name)).isDirectory()) {
      stripCollidingDstSymlinks(join(src, name), dstPath, isExcluded);
    }
  }
}

/**
 * Recursive overlay `cpSync` (`recursive`, `force`, `verbatimSymlinks`) with a
 * shared file/directory type-collision guard. When a path changes type upstream
 * (a directory `foo/` becomes a file `foo`, or a `.jsonl` becomes a directory),
 * `cpSync` throws `EINVAL` / `ENOTEMPTY` or one of the documented `ERR_FS_CP_*`
 * codes; this converts any of them into a `NomadFatal` that names the colliding
 * path and points at `nomad pull --force-remote`, so callers surface an
 * actionable message instead of a raw stack trace. Any other I/O error
 * propagates unchanged. The single source of truth for that guard, shared by the
 * `.planning` extras overlays and the pull-side session overlay so they cannot
 * drift.
 *
 * @param src - Source directory to copy from.
 * @param dst - Destination path.
 * @param filter - Optional `cpSync` entry filter; `undefined` copies everything.
 * @param label - Function name to prefix the collision message with.
 */
export function cpSyncGuarded(
  src: string,
  dst: string,
  filter: ((srcEntry: string) => boolean) | undefined,
  label: string,
): void {
  try {
    cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true, filter });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // cpSync tried to overwrite a non-empty directory with a file (or vice
    // versa) -- a file/dir type change upstream. The code varies by platform
    // and Node version: EINVAL/ENOTEMPTY on current runtimes, the ERR_FS_CP_*
    // family in Node's documented error set. On win32, cpSync's internal
    // unlink/rmdir fallback for this same collision can surface the raw
    // Windows ERROR_DIR_NOT_EMPTY system code (145) in `errno` with `code`
    // left empty (`''`), instead of the normalized `ENOTEMPTY`; match that
    // shape too. Convert any of them to NomadFatal.
    /* c8 ignore start -- collision codes are platform/Node-version-specific */
    if (
      e.code === 'EINVAL' ||
      e.code === 'ENOTEMPTY' ||
      e.code === 'ERR_FS_CP_NON_DIR_TO_DIR' ||
      e.code === 'ERR_FS_CP_DIR_TO_NON_DIR' ||
      (process.platform === 'win32' && e.errno === 145)
    ) {
      throw new NomadFatal(
        `${label}: type collision copying ${quoted(src)} -> ` +
          `${quoted(dst)} (${e.path ?? 'unknown path'}): a file/directory type ` +
          `changed upstream; run nomad pull --force-remote to recover`,
      );
    }
    throw err; // other I/O error; propagate as-is
    /* c8 ignore stop */
  }
}

/**
 * Predicate-driven recursive prune variant. Like `prunePreservingDenied` but
 * the preserve/exclude decision is an `isPreserved(name)` predicate instead of
 * a fixed `Set`. This is required for the skills pull path: a local `gsd-*`
 * skill present in dst but ABSENT from src must be preserved, but a src-derived
 * blockSet would not contain it (the name was never in src) and would therefore
 * delete it (a Phase-49-class mirror-delete). The predicate tests the `gsd-`
 * prefix directly so presence in src is irrelevant.
 *
 * @param src - Source directory (repo side on pull).
 * @param dst - Destination directory (host side on pull); assumed to exist.
 * @param isPreserved - Returns `true` for a basename that must not be removed
 *   from dst even when absent from src.
 */
function prunePreservingBy(src: string, dst: string, isPreserved: (name: string) => boolean): void {
  for (const name of readdirSync(dst)) {
    if (isPreserved(name)) continue;
    const dstPath = join(dst, name);
    const srcStat = lstatSync(join(src, name), { throwIfNoEntry: false });
    if (srcStat === undefined) {
      rmSync(dstPath, { recursive: true, force: true });
      continue;
    }
    const dstStat = lstatSync(dstPath);
    if (srcStat.isDirectory() && dstStat.isDirectory()) {
      prunePreservingBy(join(src, name), dstPath, isPreserved);
    } else if (srcStat.isDirectory() !== dstStat.isDirectory()) {
      rmSync(dstPath, { recursive: true, force: true });
    }
  }
}

/**
 * Predicate-driven preserving overlay copy. Like `copyExtrasFilteredPreserving`
 * but the preserve/exclude decision is an `isPreserved(name)` predicate rather
 * than a fixed `Set`, so entries that should be preserved can be identified
 * without scanning src (critical for the skills pull path, where a local
 * gsd-* skill absent from src must survive regardless). The root prune uses
 * `prunePreservingBy`; the `cpSync` filter excludes any non-root entry for
 * which `isPreserved(basename(entry))` is true (defense-in-depth: repo-side
 * preserved-category entries are not overlaid). A not-yet-existing dst is
 * handled cleanly. A dst that exists but is not a real directory is removed
 * wholesale before the copy. Passes `verbatimSymlinks: true` (see nodejs/node
 * issue 41693).
 *
 * If `dst` already exists as a directory but `src` is a FILE (a repo-side
 * dir/file type flip), `prunePreservingBy` would `readdirSync(dst)` then
 * `lstatSync(join(src, name))`, and joining a filename onto a file path
 * raises a raw `ENOTDIR` instead of the intended "absent from src" no-entry
 * case. That is guarded here up front: a file-src / directory-dst mismatch is
 * converted into an actionable `NomadFatal` naming both paths and pointing at
 * `nomad pull --force-remote`, mirroring the `cpSyncGuarded` type-collision
 * convention, instead of letting the raw fs error abort `cmdPull`
 * mid-mutation. The reverse mismatch (directory `src`, file `dst`) is not
 * affected by that `ENOTDIR` failure mode; it already falls through to the
 * existing `rmSync(dst, ...)` branch below, which safely clears the file so
 * `cpSync` can recreate it as a directory.
 *
 * @param src - Source directory to copy from (repo side on pull).
 * @param dst - Destination path (host-side dir on pull).
 * @param isPreserved - Returns `true` for a basename that must be preserved in
 *   dst and excluded from the src copy.
 */
export function copyExtrasFilteredPreservingBy(
  src: string,
  dst: string,
  isPreserved: (name: string) => boolean,
): void {
  const dstStat = lstatSync(dst, { throwIfNoEntry: false });
  if (dstStat !== undefined) {
    if (dstStat.isDirectory()) {
      const srcStat = lstatSync(src, { throwIfNoEntry: false });
      if (srcStat !== undefined && !srcStat.isDirectory()) {
        throw new NomadFatal(
          `copyExtrasFilteredPreservingBy: type mismatch copying ${quoted(src)} -> ` +
            `${quoted(dst)}: the repo entry is a file but the local entry is a ` +
            `directory; run nomad pull --force-remote to recover`,
        );
      }
      prunePreservingBy(src, dst, isPreserved);
    } else {
      rmSync(dst, { recursive: true, force: true });
    }
  }
  stripCollidingDstSymlinks(src, dst, isPreserved);
  cpSync(src, dst, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (srcEntry) => srcEntry === src || !isPreserved(basename(srcEntry)),
  });
}
