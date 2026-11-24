import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Part 3 of the lockfile tests: atomic publish and write-failure cleanup.
 * The lock appears only via a hard link of a fully written temp file, so the
 * lock path never exists without its PID. When the PID write fails, acquireLock
 * and retryOnce must close the fd and leave neither lock nor temp file.
 * SUT loads from ./utils.lockfile.ts.
 */
describe('acquireLock / retryOnce: atomic publish and PID-write failure cleanup (issue #139)', () => {
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
    // Clean slate: no pre-existing lock. The temp file opens, then
    // writeFileSync(fd, pid) throws EACCES. acquireLock must close the fd and
    // remove the temp file before rethrowing the original error. The real fs
    // calls are used so actual state is observable; only the fd write is
    // intercepted.
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
    // Neither the lock nor the temp file may remain after the write failure.
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('acquireLock: surfaces the ORIGINAL write error even when the cleanup unlink also fails', async () => {
    // Regression for cleanup masking the primary error: writeFileSync(fd) fails
    // with EACCES AND the best-effort temp-file unlink then throws a non-ENOENT
    // error (EPERM). acquireLock must rethrow the ORIGINAL write error (EACCES),
    // never the secondary cleanup error. The temp file is left behind here (the
    // unlink was forced to fail) and cleaned up in afterEach.
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
            if (typeof path === 'number') {
              const err = new Error('permission denied') as NodeJS.ErrnoException;
              err.code = 'EACCES';
              throw err;
            }
            return actual.writeFileSync(path, data, opts);
          },
        ),
        unlinkSync: vi.fn(() => {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }),
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
  });

  it('retryOnce: returns null and leaves no lock or temp file when writeFileSync(fd) fails in the stale-lock retry path', async () => {
    // Plant a dead PID so checkStaleAndRetry detects ESRCH, reaps the stale
    // lock, and calls retryOnce. The retry's PID write throws ENOSPC. Only a
    // fd write made while the lock path is absent (the retry) is failed; the
    // first attempt, made while the planted lock still exists, passes through.
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
            if (typeof path === 'number' && !actual.existsSync(lockPath)) {
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
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('happy path: normal acquire and release leaves no lockfile', async () => {
    // Regression guard: a successful acquire + release cycle leaves the lock
    // dir empty (no temp or grave sibling), asserted after release so a
    // Windows delete-pending temp name cannot flake it.
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('window probe: the PID is written while the lock path does not yet exist', async () => {
    // Records whether the lock path exists at the moment of every fd write.
    // Atomic publish means it must be absent: a contender can never read an
    // empty PID at the lock path.
    const seen: boolean[] = [];
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
            if (typeof path === 'number') seen.push(actual.existsSync(lockPath));
            return actual.writeFileSync(path, data, opts);
          },
        ),
      };
    });
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(seen).toEqual([false]);
    expect(readFileSync(lockPath, 'utf8').split(' ')[0]).toBe(String(process.pid));
    releaseLock(handle);
  });

  it('a stray temp file from a crashed process with a reused pid does not wedge acquire', async () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(`${lockPath}.${process.pid}.tmp`, 'garbage');
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8').split(' ')[0]).toBe(String(process.pid));
    releaseLock(handle);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('a stray temp hard-linked to a stale lock is unlinked, not truncated, before reuse', async () => {
    // A crash after the publish link but before the temp cleanup leaves the
    // temp sharing the lock's inode. Opening it with 'w' would truncate the
    // lock (an empty PID) while a contender may be reading it; acquire must
    // break the link first. Observe the shared inode at the first fd write:
    // the planted lock must still hold its dead PID.
    const deadPid = 2147483647;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, String(deadPid));
    linkSync(lockPath, `${lockPath}.${process.pid}.tmp`);
    const atWrite: string[] = [];
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
            if (typeof path === 'number' && actual.existsSync(lockPath)) {
              atWrite.push(actual.readFileSync(lockPath, 'utf8'));
            }
            return actual.writeFileSync(path, data, opts);
          },
        ),
      };
    });
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(atWrite[0]).toBe(String(deadPid));
    releaseLock(handle);
    expect(readdirSync(lockDir)).toEqual([]);
  });
});
