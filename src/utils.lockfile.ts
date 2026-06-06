import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { home } from './config.ts';
import { warn } from './utils.ts';

/** Returns the lock file path resolved under the current HOME at call time. */
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
 * Acquire the exclusive nomad lockfile so two pulls/pushes cannot mutate
 * `~/.claude/` concurrently. Returns the handle on success, or `null` on
 * contention (caller should `process.exit(0)`; skip-on-contention is the
 * intended UX for backgrounded shell-rc invocations). Detects stale locks by
 * probing the recorded pid with `kill(pid, 0)` and recovers via
 * `unlinkIfSamePid` + `retryOnce`. `verb` is `'pull'` or `'push'`; surfaces
 * in the contention-skip message.
 */
export function acquireLock(verb: string): LockHandle | null {
  const lp = lockFilePath();
  mkdirSync(dirname(lp), { recursive: true });
  try {
    const fd = openSync(lp, 'wx');
    try {
      writeFileSync(fd, String(process.pid));
    } catch (writeErr) {
      // PID-write failed after the lock file was created. Best-effort cleanup:
      // close the fd (ignore errors), then unlink the orphaned lock file
      // (ignore ANY unlink failure). The original write error is rethrown
      // unconditionally, so a cleanup failure can never mask it and non-EEXIST
      // throw semantics are preserved.
      try {
        closeSync(fd);
      } catch {
        /* already closed; ignore */
      }
      try {
        unlinkSync(lp);
      } catch {
        /* best-effort cleanup; the original write failure takes precedence */
      }
      throw writeErr;
    }
    return { fd, path: lp };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    return checkStaleAndRetry(verb, lp);
  }
}

/**
 * Release a previously-acquired lock handle. No-op when `handle` is null
 * (matches `acquireLock`'s contention return). Tolerates the lockfile having
 * already been unlinked. MUST be called from a `finally` so it runs even when
 * the wrapped command throws.
 */
export function releaseLock(handle: LockHandle | null): void {
  if (handle === null) return;
  const lp = handle.path;
  try {
    closeSync(handle.fd);
  } catch {
    /* already closed; ignore */
  }
  try {
    unlinkSync(lp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Compare-and-delete helper that closes most of the TOCTOU window between
 * reading a stale lock's pid and removing it: another process could
 * legitimately acquire the lock between those steps, and a naive unlink
 * would clobber it. Re-reads the file and only unlinks if the contents
 * still equal `expectedPidStr`. Returns `true` if the lock was unlinked,
 * `false` if the content drifted or the file already vanished. A microsecond
 * window between the re-read and the unlink remains; the residual race is
 * documented as a backlog item rather than fully closed here.
 *
 * @param expectedPidStr The pid string read earlier from the lockfile.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function unlinkIfSamePid(expectedPidStr: string, lp: string): boolean {
  let current: string;
  try {
    current = readFileSync(lp, 'utf8').trim();
  } catch {
    return false;
  }
  /* c8 ignore next -- TOCTOU drift between the two reads is a documented residual race, hard to exercise deterministically */
  if (current !== expectedPidStr) return false;
  try {
    unlinkSync(lp);
    return true;
  } catch {
    return false;
  }
}

/**
 * EEXIST recovery path for `acquireLock`. Reads the lockfile pid, probes
 * liveness with `kill(pid, 0)`, and tries one retry only when the pid is
 * dead AND the compare-and-delete in `unlinkIfSamePid` confirms the file
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
    if (unlinkIfSamePid(pidStr, lp)) return retryOnce(verb, lp);
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
      if (unlinkIfSamePid(pidStr, lp)) return retryOnce(verb, lp);
      warn(`another nomad ${verb} running, skipping`);
      return null;
    }
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
}

/**
 * Single retry of `openSync(..., 'wx')` after `unlinkIfSamePid` cleared a
 * confirmed-stale lock. Bounded to one attempt to avoid spin loops if the
 * lock is being rapidly recreated by another live process.
 *
 * @param verb `'pull'` or `'push'`; surfaces in the contention-skip message.
 * @param lp Lock path resolved once by `acquireLock`.
 */
function retryOnce(verb: string, lp: string): LockHandle | null {
  try {
    const fd = openSync(lp, 'wx');
    try {
      writeFileSync(fd, String(process.pid));
    } catch {
      // Twin of the acquireLock write-failure guard. Best-effort cleanup: close
      // the fd (ignore errors) and unlink the orphaned lock file (ignore ANY
      // unlink failure). retryOnce's null-on-failure contract is preserved.
      try {
        closeSync(fd);
      } catch {
        /* already closed; ignore */
      }
      try {
        unlinkSync(lp);
      } catch {
        /* best-effort cleanup; the null return below is the contract */
      }
      warn(`another nomad ${verb} running, skipping`);
      return null;
    }
    return { fd, path: lp };
  } catch {
    warn(`another nomad ${verb} running, skipping`);
    return null;
  }
}
