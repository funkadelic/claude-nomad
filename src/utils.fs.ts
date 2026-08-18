import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { backupBase, claudeHome } from './config.ts';
import { encodePath } from './utils.json.ts';
import { die, log } from './utils.ts';

/**
 * Total attempts (including the first) `renameAtomicRetry` makes on win32
 * before giving up and re-throwing the last error.
 */
const RENAME_RETRY_MAX_ATTEMPTS = 5;

/**
 * Synchronous backoff between `renameAtomicRetry` win32 attempts, in
 * milliseconds. Short and bounded: long enough for a transient antivirus or
 * indexer file lock to clear, short enough that the worst case (all
 * `RENAME_RETRY_MAX_ATTEMPTS` attempts fail) adds only tens of milliseconds.
 */
const RENAME_RETRY_BACKOFF_MS = 10;

/**
 * Returns true when `code` is a transient Windows file-lock errno
 * (`EPERM`/`EBUSY`) that a bounded retry can plausibly clear, rather than a
 * real failure that should surface immediately. Extracted to keep
 * `renameAtomicRetry` under the cognitive-complexity gate.
 */
function isRetryableRenameCode(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY';
}

/**
 * Synchronous bounded busy-wait used only inside `renameAtomicRetry`'s win32
 * backoff. `Atomics.wait` on a throwaway `SharedArrayBuffer` blocks the
 * calling thread for `ms` milliseconds without yielding to the event loop;
 * every caller here is a synchronous fs helper that cannot `await`.
 */
function sleepSyncMs(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Rename `tmp` over `dst`, retrying on win32 when the OS reports a transient
 * file lock. NTFS can hold a brief handle on a file being renamed over
 * (Windows Defender scanning it, the Search indexer reading it), so a single
 * `renameSync` over an existing destination intermittently throws
 * `EPERM`/`EBUSY` on Windows even though the lock clears within
 * milliseconds. This targets exactly that destination-already-exists
 * overwrite case, which every atomic-write site in this codebase hits on
 * every write.
 *
 * On any platform other than win32 this is exactly one `renameFn(tmp, dst)`
 * call with no retry, no backoff, and no added latency; posix behavior is
 * byte-identical to a bare `renameSync` call. On win32 it retries only when
 * the caught error's `.code` is `EPERM` or `EBUSY`, up to
 * `RENAME_RETRY_MAX_ATTEMPTS` total attempts with a short synchronous
 * backoff between attempts. Any other error code re-throws immediately with
 * no retry. After the attempt cap is exhausted the last error is re-thrown,
 * so a permanent lock surfaces as a real error rather than hanging.
 *
 * @param tmp - Source path (the temp file/dir being renamed into place).
 * @param dst - Destination path; may already exist, which is the case this
 *   helper exists to cover.
 * @param renameFn - Injectable `renameSync`-shaped function so tests can
 *   stub failure/success sequences without touching the real filesystem.
 *   Defaults to the real `renameSync`.
 */
export function renameAtomicRetry(
  tmp: string,
  dst: string,
  renameFn: typeof renameSync = renameSync,
): void {
  if (process.platform !== 'win32') {
    renameFn(tmp, dst);
    return;
  }
  for (let attempt = 1; attempt <= RENAME_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      renameFn(tmp, dst);
      return;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isRetryableRenameCode(code) || attempt === RENAME_RETRY_MAX_ATTEMPTS) throw e;
      sleepSyncMs(RENAME_RETRY_BACKOFF_MS);
    }
  }
}

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
  renameAtomicRetry(tmp, path);
  // Fsync the parent directory so the rename itself is durable across a crash;
  // otherwise the file contents are persisted but the directory entry can be
  // lost. Linux/macOS support this on a read-only fd to the dir.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } catch (e: unknown) {
    // Windows cannot fsync a directory handle and always throws EPERM, so
    // skip the durability step there; on every other platform EPERM is a
    // real error and still throws.
    if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
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
 * Remove `backupRoot` when the run that created it snapshotted nothing into it.
 *
 * The backup dir is created eagerly, before the first destructive step, so a
 * full disk or a permission problem fails the run before it has mutated
 * anything rather than halfway through. Two runs then leave it holding
 * nothing: a first pull on a host with no `~/.claude/settings.json` or
 * `skills/` to snapshot yet, and any run that fails between the mkdir and its
 * first snapshot. On an established host a wet pull always snapshots
 * `settings.json` (`regenerateSettings`) and `skills/` (`syncSkillsPull`), so
 * this is a no-op there.
 *
 * `rmdirSync` rather than a recursive remove, and that is the whole safety
 * argument: it refuses a directory with anything in it, so the decision of
 * whether this run's snapshot is worth keeping is made by the filesystem
 * against the real directory rather than by a predicate that could be wrong.
 * Every failure is swallowed: ENOTEMPTY means a real snapshot landed and must
 * stay, ENOENT means the run never got as far as creating it, and anything
 * else (a read-only cache, an antivirus lock) leaves one stale empty dir
 * behind, which is not worth failing a completed run over. `nomad clean
 * --backups` prunes empty dirs whatever their age, so an entry that survives
 * here is still recoverable ground.
 *
 * @param backupRoot - Absolute path to this run's `backupBase()/<ts>` dir.
 */
export function discardEmptyBackupDir(backupRoot: string): void {
  try {
    rmdirSync(backupRoot);
  } catch {
    // Deliberately silent; see the note above on why each failure is fine.
  }
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
 *
 * @returns `true` when the copy ran, `false` when neither no-op guard let it
 *   (the source is missing, or it resolves outside `anchor`). A caller that
 *   tells the user where the previous content went needs the distinction: the
 *   guards are checked here, so predicting them from outside is a guess that
 *   goes stale the moment the entry changes between the two reads.
 */
function backupUnder(absPath: string, anchor: string, destRoot: string): boolean {
  if (!existsSync(absPath)) return false;
  const rel = relative(anchor, absPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  const dst = join(destRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(absPath, dst, { recursive: true, force: false, preserveTimestamps: true });
  return true;
}

/**
 * Snapshot `absPath` into `backupBase()/<ts>/<rel>` before destructive write.
 * No-op if source missing or outside claudeHome(). Recursive for directories.
 *
 * @returns `true` when the copy ran, `false` when it was a no-op (source
 *   missing, or outside `claudeHome()`). The sibling wrappers below return
 *   nothing: only this one has a caller that reports the snapshot to the user.
 */
export function backupBeforeWrite(absPath: string, ts: string): boolean {
  return backupUnder(absPath, claudeHome(), join(backupBase(), ts));
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
