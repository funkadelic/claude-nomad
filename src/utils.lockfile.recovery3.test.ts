import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Part 3 of the lockfile tests: regression coverage for the fd/lock leak
 * that occurs when writeFileSync(fd, pid) fails after openSync('wx')
 * succeeds in acquireLock and retryOnce. Both functions must close the fd
 * and unlink LOCK_PATH on PID-write failure, leaving no orphaned lockfile.
 * SUT loads from ./utils.lockfile.ts.
 */
describe('acquireLock / retryOnce: PID-write failure cleanup (issue #139)', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockDir: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lockfile-test3-'));
    process.env.HOME = testHome;
    lockDir = join(testHome, '.cache', 'claude-nomad');
    lockPath = join(lockDir, 'nomad.lock');
    stderrWrites = [];
    // warn() routes through console.error; capture both stdio paths so the
    // lock-contention assertions remain stream-agnostic.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrWrites.push(args.map(String).join(' ') + '\n');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    try {
      unlinkSync(lockPath);
    } catch {
      /* defensive cleanup; ignore */
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('acquireLock: rethrows the original write error and leaves no lockfile when writeFileSync(fd) fails', async () => {
    // Clean slate: no pre-existing lock. openSync('wx') succeeds creating the
    // file, then writeFileSync(fd, pid) throws EACCES. acquireLock must close
    // the fd and unlink LOCK_PATH before rethrowing the original error.
    // The real openSync, closeSync, and unlinkSync are used so actual fs state
    // is observable; only writeFileSync for the lock fd is intercepted.
    mkdirSync(lockDir, { recursive: true });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        writeFileSync: vi.fn(
          (
            path: fsModule.PathOrFileDescriptor,
            data: Parameters<typeof actual.writeFileSync>[1],
            opts?: Parameters<typeof actual.writeFileSync>[2],
          ) => {
            // Intercept only the fd write that records our PID. Numeric path
            // = fd argument from acquireLock/retryOnce's writeFileSync(fd, pid).
            // All other writes (string paths, setup writes, etc.) pass through.
            if (typeof path === 'number') {
              const err = new Error('permission denied') as NodeJS.ErrnoException;
              err.code = 'EACCES';
              throw err;
            }
            return actual.writeFileSync(path, data, opts);
          },
        ),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const thrown = (() => {
      try {
        acquireLock('pull');
        return null;
      } catch (err) {
        return err as NodeJS.ErrnoException;
      }
    })();
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('EACCES');
    // The lockfile must not remain orphaned after the write failure.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('retryOnce: returns null and leaves no lockfile when writeFileSync(fd) fails in the stale-lock retry path', async () => {
    // Plant a dead PID so checkStaleAndRetry detects ESRCH, unlinks the stale
    // lock, and calls retryOnce. retryOnce's openSync('wx') then succeeds, but
    // its writeFileSync(fd, pid) throws ENOSPC. retryOnce must close the fd
    // and unlink LOCK_PATH, then return null (existing catch contract).
    const deadPid = 2147483647;
    let guarded = false;
    try {
      process.kill(deadPid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') guarded = true;
    }
    if (!guarded) {
      throw new Error(`PID ${deadPid} unexpectedly live; pick a higher PID.`);
    }
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, String(deadPid));

    // Track how many fd writes are attempted so we target only retryOnce's
    // write (the second numeric-fd writeFileSync call, after acquireLock's
    // first call hits EEXIST and stale-recovery runs retryOnce).
    let fdWriteCount = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        writeFileSync: vi.fn(
          (
            path: fsModule.PathOrFileDescriptor,
            data: Parameters<typeof actual.writeFileSync>[1],
            opts?: Parameters<typeof actual.writeFileSync>[2],
          ) => {
            if (typeof path === 'number') {
              fdWriteCount++;
              const err = new Error('no space left on device') as NodeJS.ErrnoException;
              err.code = 'ENOSPC';
              throw err;
            }
            return actual.writeFileSync(path, data, opts);
          },
        ),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    // retryOnce returns null (not rethrow) so no throw is expected.
    // The lockfile must not remain orphaned.
    expect(existsSync(lockPath)).toBe(false);
    // Exactly one fd write was attempted (retryOnce's write after the stale unlink).
    expect(fdWriteCount).toBe(1);
  });

  it('happy path: normal acquire and release leaves no lockfile', async () => {
    // Regression guard: the existing EEXIST -> checkStaleAndRetry control
    // flow, the LockHandle | null return, and a successful acquire + release
    // cycle are all unaffected by the write-failure guard added around
    // writeFileSync in acquireLock and retryOnce.
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });
});
