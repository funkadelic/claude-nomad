import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { backupBase, claudeHome } from './config.ts';
import { encodePath } from './utils.json.ts';
import { die, log } from './utils.ts';

/**
 * Atomic write: temp + fsync + rename + parent-dir fsync. Survives
 * interrupted pulls. Preserves the destination file's existing mode when it
 * exists, defaults to 0o600 otherwise so credentials in `settings.json` are
 * not widened by the process umask on every regenerate.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Fsync the parent directory so the rename itself is durable across a crash;
  // otherwise the file contents are persisted but the directory entry can be
  // lost. Linux/macOS support this on a read-only fd to the dir.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } catch (e: unknown) {
    // Windows does not support fsync on directory file descriptors.
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  } finally {
    closeSync(dirFd);
  }
}

/** Local-time YYYYMMDD-HHMMSS timestamp; lexicographically sortable. Pure. */
export function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Collision-resistant backup timestamp. `nowTimestamp()` is second-resolution,
 * so two pulls in the same wall-clock second would share `ts`, and the
 * second's `backupBeforeWrite` calls (which use `cpSync` with `force:false`)
 * would silently no-op against the existing first snapshot. Append a `-N`
 * suffix until the backup dir is unique.
 */
export function freshBackupTs(backupRoot: string): string {
  const base = nowTimestamp();
  if (!existsSync(join(backupRoot, base))) return base;
  let n = 1;
  while (existsSync(join(backupRoot, `${base}-${n}`))) n++;
  return `${base}-${n}`;
}

/**
 * Create a symlink at `linkPath` pointing to `target`, idempotently. No-op if
 * a symlink already exists at `linkPath`; dies if a non-symlink exists there
 * (caller should pre-scan and back up first; see `applySharedLinks`).
 */
export function ensureSymlink(linkPath: string, target: string): void {
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) return;
    die(`${linkPath} exists and is not a symlink. Move it aside first.`);
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  log(`linked ${linkPath} -> ${target}`);
}

/**
 * Snapshot `absPath` into `destRoot/<rel>` (where `rel = relative(anchor,
 * absPath)`) before a destructive write. No-op if the source is missing or
 * resolves outside `anchor`. The escape guard tests `..` at a path-segment
 * boundary (`rel === '..'` or a `..<sep>` prefix) rather than a bare
 * `startsWith('..')`, so a legitimate sibling entry whose name merely begins
 * with `..` (e.g. `..config`) is still backed up. Recursive for directories;
 * `force: false` so a same-`ts` collision drops the second copy rather than
 * overwriting an earlier snapshot. Shared core behind the three scoped
 * wrappers below, which differ only by their anchor and `destRoot`.
 */
function backupUnder(absPath: string, anchor: string, destRoot: string): void {
  if (!existsSync(absPath)) return;
  const rel = relative(anchor, absPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return;
  const dst = join(destRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(absPath, dst, { recursive: true, force: false, preserveTimestamps: true });
}

/**
 * Snapshot `absPath` into `backupBase()/<ts>/<rel>` before destructive write.
 * No-op if source missing or outside claudeHome(). Recursive for directories.
 */
export function backupBeforeWrite(absPath: string, ts: string): void {
  backupUnder(absPath, claudeHome(), join(backupBase(), ts));
}

/**
 * Parallel of `backupBeforeWrite`, but scoped to `repoHome` instead of
 * `claudeHome()`. Used by `remapPush` to snapshot repo-side encoded-dir
 * state before `copyDir` clobbers it. Backup root is repo-prefixed so the
 * dump is distinguishable from `claudeHome()` backups in the same `ts` dir.
 */
export function backupRepoWrite(absPath: string, ts: string, repoHome: string): void {
  backupUnder(absPath, repoHome, join(backupBase(), ts, 'repo'));
}

/**
 * Parallel of `backupBeforeWrite` and `backupRepoWrite`, scoped to an
 * explicit `projectRoot` instead of `CLAUDE_HOME` or `REPO_HOME`. Used by
 * `remapExtrasPull` to snapshot host-side extras content (e.g.
 * `<localRoot>/.planning/`) before `copyExtras` clobbers it. The existing
 * helpers cannot serve this case: their `relative(CLAUDE_HOME, absPath)` and
 * `relative(repoHome, absPath)` guards return a `..`-prefixed string for any
 * path outside their anchor and silently no-op, so a pull-side
 * `<localRoot>/.planning/` would never be backed up.
 *
 * Backup root is `extras/`-prefixed inside the same `<ts>` dir so the
 * snapshot is distinguishable from `CLAUDE_HOME` dumps (no prefix) and
 * `repo/` dumps. Layout:
 * `backupBase()/<ts>/extras/<encoded-projectRoot>/<rel>/`
 * where `<rel>` is `relative(projectRoot, absPath)` and
 * `<encoded-projectRoot>` is `encodePath(projectRoot)`. The encoded prefix
 * namespaces snapshots by project so two opted-in projects with the same
 * relative extras path (e.g. both with `.planning/PLAN.md`) cannot collide
 * inside the same `<ts>` directory (`cpSync` runs with `force: false`, so a
 * collision would silently drop the second snapshot).
 */
export function backupExtrasWrite(absPath: string, ts: string, projectRoot: string): void {
  backupUnder(absPath, projectRoot, join(backupBase(), ts, 'extras', encodePath(projectRoot)));
}
