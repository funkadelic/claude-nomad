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
 * Create the lock by writing our PID to a pid-unique temp sibling and hard
 * linking it onto `lp`. The link is atomic and fails EEXIST while the lock is
 * held, so the lock path never exists without its full PID. On failure nothing
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
    writeFileSync(fd, String(process.pid));
    linkSync(tmp, lp);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* already closed; ignore */
    }
    unlinkQuietly(tmp);
    throw err;
  }
  unlinkQuietly(tmp);
  return { fd, path: lp };
}

/**
 * Acquire the exclusive nomad lockfile so two pulls/pushes cannot mutate
 * `~/.claude/` concurrently. Returns the handle on success, or `null` on
 * contention (caller should `process.exit(EXIT.SUCCESS)`; skip-on-contention is the
 * intended UX for backgrounded shell-rc invocations). The lock is published
 * atomically by `createLock`. On EEXIST, detects stale locks by probing the
 * recorded pid with `kill(pid, 0)` and recovers via `reapIfSamePid` +
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
    try {
      closeSync(handle.fd);
    } catch {
      /* already closed; ignore */
    }
  }
}

/**
 * Finish a move-then-check: delete `grave` if `ours`, else link it back onto `lp` first.
 * @param grave Pid-unique name the lock was renamed to. @param lp Lock path. @param ours Ownership.
 */
function settleGrave(grave: string, lp: string, ours: boolean): void {
  if (!ours) {
    try {
      linkSync(grave, lp);
    } catch {
      /* the path was retaken meanwhile; keep theirs */
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
 * @param expectedPidStr The pid string read earlier from the lockfile.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function reapIfSamePid(expectedPidStr: string, lp: string): boolean {
  const grave = `${lp}.${process.pid}.stale`;
  try {
    renameSync(lp, grave);
  } catch {
    return false;
  }
  let stale = false;
  try {
    stale = readFileSync(grave, 'utf8').trim() === expectedPidStr;
  } catch {
    /* unreadable grave is treated as live and restored */
  }
  // Residual: a third process can take the lock path in the gap before a restore.
  settleGrave(grave, lp, stale);
  return stale;
}

/**
 * EEXIST recovery path for `acquireLock`. Reads the lockfile pid, probes
 * liveness with `kill(pid, 0)`, and tries one retry only when the pid is
 * dead AND the compare-and-reap in `reapIfSamePid` confirms the file
 * has not been replaced under us. Returns `null` (contention skip) in any
 * other case.
 *
 * @param verb `'pull'` or `'push'`; surfaces in the contention-skip message.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function checkStaleAndRetry(verb: string, lp: string): LockHandle | null {
  let pidStr: string;
  try {
    pidStr = readFileSync(lp, 'utf8').trim();
  } catch {
    pidStr = '';
  }
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    if (reapIfSamePid(pidStr, lp)) return retryOnce(verb, lp);
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
  try {
    process.kill(pid, 0);
    warn(`another nomad ${verb} running, skipping`);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      if (reapIfSamePid(pidStr, lp)) return retryOnce(verb, lp);
      warn(`another nomad ${verb} running, skipping`);
      return null;
    }
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
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
