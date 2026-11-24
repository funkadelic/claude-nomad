import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { home } from './config.ts';
import { warn } from './utils.ts';

/**
 * Returns the lock file path resolved under the current HOME at call time.
 *
 * The lock is keyed on HOME, not on `REPO_HOME`, because the mutating commands
 * it guards (`pull`/`push`) write HOME-scoped state (`~/.claude/settings.json`,
 * symlinks, `~/.claude/projects/`) in addition to the repo. For the normal
 * single-user setup HOME and the repo move together, so this is correct.
 *
 * Caveat: a `NOMAD_REPO` override decouples them. Two concurrent invocations
 * pointed at the same `NOMAD_REPO` but launched under different HOME values
 * would acquire different locks yet mutate the same repo. Do not combine a
 * `NOMAD_REPO` override with concurrent default-HOME runs; the override is a
 * single-checkout developer convenience, not a concurrency mechanism.
 */
function lockFilePath(): string {
  return join(home(), '.cache', 'claude-nomad', 'nomad.lock');
}

/**
 * Opaque handle for an acquired lockfile. Pass to `releaseLock` in a
 * `finally`. Carries the exact path opened by `acquireLock` so release
 * always targets the same file even if HOME changes mid-process.
 */
export type LockHandle = { fd: number; path: string };

/**
 * Remove `p`, ignoring any failure (missing file, permissions). Best effort.
 */
function unlinkQuietly(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* best effort; nothing useful to do on failure */
  }
}

/**
 * Read and trim a small text file, or `undefined` when it cannot be read.
 *
 * @param p File path.
 */
function readTrimmed(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Returns `<starttime>@<boot_id>` for `pid` (start time is field 22 of
 * `/proc/<pid>/stat`), or `undefined` without a readable `/proc`. The boot id
 * keeps a pid and tick pair repeated after a reboot from matching.
 *
 * @param pid Process id to inspect.
 */
function procIdentity(pid: number): string | undefined {
  const stat = readTrimmed(`/proc/${pid}/stat`);
  if (stat === undefined) return undefined;
  // comm (field 2) may hold spaces and parens, so parse after the last ')'.
  const start = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(' ')[19];
  return [start, readTrimmed('/proc/sys/kernel/random/boot_id')].join('@');
}

let cachedContent: string | undefined;

/**
 * Returns the content this process writes into the lock, `<pid> <identity>` or
 * just `<pid>` without `/proc`. Cached: it never changes within a process.
 */
function lockContent(): string {
  if (cachedContent === undefined) {
    const id = procIdentity(process.pid);
    cachedContent = id === undefined ? String(process.pid) : `${process.pid} ${id}`;
  }
  return cachedContent;
}

/**
 * Returns whether the lock owner is still running. ESRCH means dead; any other
 * kill outcome (EPERM included) still gets the start-time check, since a
 * recycled PID may belong to another user. Unreadable evidence counts as alive.
 *
 * @param pid Owner pid read from the lock.
 * @param recordedStart Identity recorded in the lock, if any.
 */
function ownerAlive(pid: number, recordedStart: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (recordedStart === undefined) return true;
  const current = procIdentity(pid);
  return current === undefined || current === recordedStart;
}

/**
 * Create the lock by writing our lock content to a pid-unique temp sibling and
 * hard linking it onto `lp`. The link is atomic and fails EEXIST while the lock
 * is held, so the lock path never exists without its full content. On failure nothing
 * was published and the error is rethrown.
 *
 * @param lp Lock path resolved once by `acquireLock`.
 */
function createLock(lp: string): LockHandle {
  const tmp = `${lp}.${process.pid}.tmp`;
  // A tmp left by a crashed process may still be linked to a stale lock;
  // unlink first so opening it with 'w' cannot truncate that shared inode.
  unlinkQuietly(tmp);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, lockContent());
    linkSync(tmp, lp);
  } catch (err) {
    closeQuietly(fd);
    unlinkQuietly(tmp);
    if (NO_HARDLINK_CODES.has(String((err as NodeJS.ErrnoException).code))) {
      return createLockExclusive(lp);
    }
    throw err;
  }
  unlinkQuietly(tmp);
  return { fd, path: lp };
}

/** Link errors meaning the filesystem has no hard links (FAT, exFAT, some SMB mounts). */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Fallback create for filesystems without hard links: exclusive create, then
 * write the lock content. The lock is briefly visible without it here.
 *
 * @param lp Lock path resolved once by `acquireLock`.
 */
function createLockExclusive(lp: string): LockHandle {
  const content = lockContent();
  const fd = openSync(lp, 'wx');
  try {
    writeFileSync(fd, content);
  } catch (err) {
    closeQuietly(fd);
    unlinkQuietly(lp);
    throw err;
  }
  return { fd, path: lp };
}

/**
 * Rename `from` to `to`, ignoring any failure. Best effort.
 *
 * @param from Source path.
 * @param to Destination path.
 */
function renameQuietly(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    /* best effort; nothing useful to do on failure */
  }
}

/**
 * Close `fd`, ignoring an already-closed descriptor.
 *
 * @param fd Descriptor to close.
 */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed; ignore */
  }
}

/**
 * Acquire the exclusive nomad lockfile so two pulls/pushes cannot mutate
 * `~/.claude/` concurrently. Returns the handle on success, or `null` on
 * contention (caller should `process.exit(EXIT.SUCCESS)`; skip-on-contention is the
 * intended UX for backgrounded shell-rc invocations). The lock is published
 * atomically by `createLock`. On EEXIST, detects stale locks by probing the
 * recorded pid with `kill(pid, 0)` plus its recorded start time and recovers via `reapIfSamePid` +
 * `retryOnce`. `verb` is `'pull'` or `'push'`; surfaces in the contention-skip
 * message.
 */
export function acquireLock(verb: string): LockHandle | null {
  const lp = lockFilePath();
  mkdirSync(dirname(lp), { recursive: true });
  try {
    return createLock(lp);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    return checkStaleAndRetry(verb, lp);
  }
}

/**
 * Release a previously-acquired lock handle. No-op when `handle` is null
 * (matches `acquireLock`'s contention return). Tolerates the lockfile having
 * already been unlinked, and leaves it alone when the path now holds another
 * process's lock. MUST be called from a `finally` so it runs even when the
 * wrapped command throws.
 */
export function releaseLock(handle: LockHandle | null): void {
  if (handle === null) return;
  const lp = handle.path;
  const grave = `${lp}.${process.pid}.release`;
  try {
    // Move first, then compare on a name only this process uses, so the file
    // checked is the file removed.
    try {
      renameSync(lp, grave);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return;
    }
    let ours = false;
    try {
      const held = fstatSync(handle.fd, { bigint: true });
      const moved = statSync(grave, { bigint: true });
      ours = held.ino === moved.ino && held.dev === moved.dev;
    } catch {
      /* identity unknown; restore rather than delete a lock we cannot prove is ours */
    }
    settleGrave(grave, lp, ours);
  } finally {
    closeQuietly(handle.fd);
  }
}

/**
 * Finish a move-then-check: delete `grave` if `ours`, else link it back onto `lp` first.
 * @param grave Pid-unique name the lock was renamed to.
 * @param lp Lock path to restore onto.
 * @param ours Whether the moved file belongs to this process.
 */
function settleGrave(grave: string, lp: string, ours: boolean): void {
  if (!ours) {
    try {
      linkSync(grave, lp);
    } catch (err) {
      // No hard links: rename back instead (may overwrite a lock retaken meanwhile).
      if (NO_HARDLINK_CODES.has(String((err as NodeJS.ErrnoException).code))) {
        renameQuietly(grave, lp);
        return;
      }
      /* otherwise the path was retaken meanwhile; keep theirs */
    }
  }
  unlinkQuietly(grave);
}

/**
 * Reap a stale lock without ever deleting a live one. The rename is atomic, so
 * afterwards this process owns the inode; the PID check runs on the grave, never
 * on the shared path. A mismatch means a live lock was moved and is restored.
 * Returns `true` if the stale lock was removed, `false` otherwise.
 *
 * @param expectedContent The lock content read earlier from the lockfile.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function reapIfSamePid(expectedContent: string, lp: string): boolean {
  const grave = `${lp}.${process.pid}.stale`;
  try {
    renameSync(lp, grave);
  } catch {
    return false;
  }
  let stale = false;
  try {
    stale = readFileSync(grave, 'utf8').trim() === expectedContent;
  } catch {
    /* unreadable grave is treated as live and restored */
  }
  // Residual: a third process can take the lock path in the gap before a restore.
  settleGrave(grave, lp, stale);
  return stale;
}

/**
 * EEXIST recovery path for `acquireLock`. Reads the lockfile pid and start
 * time, checks liveness with `ownerAlive` (kill probe plus start-time match),
 * and tries one retry only when the owner is dead AND the compare-and-reap in
 * `reapIfSamePid` confirms the file has not been replaced under us. Returns
 * `null` (contention skip) in any other case.
 *
 * @param verb `'pull'` or `'push'`; surfaces in the contention-skip message.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function checkStaleAndRetry(verb: string, lp: string): LockHandle | null {
  let content: string;
  try {
    content = readFileSync(lp, 'utf8').trim();
  } catch {
    content = '';
  }
  const pid = Number.parseInt(content, 10);
  const dead = !Number.isFinite(pid) || pid <= 0 || !ownerAlive(pid, content.split(/\s+/)[1]);
  if (dead && reapIfSamePid(content, lp)) return retryOnce(verb, lp);
  warn(`another nomad ${verb} running, skipping`);
  return null;
}

/**
 * Single retry of the shared create step after `reapIfSamePid` cleared a
 * confirmed-stale lock. Bounded to one attempt to avoid spin loops if the
 * lock is being rapidly recreated by another live process.
 *
 * @param verb `'pull'` or `'push'`; surfaces in the contention-skip message.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function retryOnce(verb: string, lp: string): LockHandle | null {
  try {
    return createLock(lp);
  } catch {
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
}
