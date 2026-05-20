import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
 * Split off from utils.test.ts to keep file sizes under the ~200-line cap.
 * Covers the stale-lock recovery branches in `checkStaleAndRetry`,
 * `unlinkIfSamePid`, and `retryOnce` that the happy-path tests in
 * utils.test.ts do not reach.
 */
describe('acquireLock stale-lock recovery branches', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockDir: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lockfile-test-'));
    process.env.HOME = testHome;
    lockDir = join(testHome, '.cache', 'claude-nomad');
    lockPath = join(lockDir, 'nomad.lock');
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    // Chmod back so rmSync can descend (Test 1 chmods lockDir to 0o500).
    try {
      chmodSync(lockDir, 0o700);
    } catch {
      /* directory may not exist; ignore */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* defensive cleanup; ignore */
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns null and writes stderr skip line when PID is non-numeric AND unlink fails', async () => {
    // Pre-write a non-numeric PID so parseInt fails (NaN, not finite).
    // Chmod the parent dir 0o500 so unlinkIfSamePid's unlinkSync throws EACCES.
    // The fallthrough from `unlinkIfSamePid -> false` lands on the stderr
    // skip line, returning null without recovering.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, 'not-a-pid');
    chmodSync(lockDir, 0o500);
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('recovers and retries successfully when PID is non-numeric AND unlink succeeds', async () => {
    // Empty string -> parseInt('') is NaN -> !Number.isFinite(pid) true ->
    // unlinkIfSamePid('') compares against the file's trimmed content '' and
    // unlinks it. retryOnce then opens the lock fresh and writes our PID.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '');
    const { acquireLock, releaseLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null when process.kill(pid, 0) throws non-ESRCH (e.g. EPERM)', async () => {
    // Plant a live PID (our own) so the liveness probe is reached. Spy on
    // process.kill so it throws EPERM (root-owned process scenario). The
    // catch's `code !== ESRCH` branch writes the skip line and returns null.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    // process.kill is a union overload (number | string for signal); the
    // spy implementation must accept the broader (string | number) and throw,
    // so coerce via `as never` after the impl to satisfy the never-returning
    // mock signature.
    vi.spyOn(process, 'kill').mockImplementation(((): boolean => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as never);
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('returns null when stale-lock confirmed but retryOnce openSync(EEXIST) fails', async () => {
    // Plant a dead PID so the ESRCH branch fires, unlinkIfSamePid succeeds,
    // then retryOnce's openSync throws EEXIST (another process raced in and
    // recreated the lockfile between unlink and our retry). retryOnce's
    // catch writes the skip line and returns null.
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

    // Mock openSync so the FIRST call (initial acquire) throws EEXIST as it
    // would naturally (lock file exists), and the SECOND call (retryOnce
    // after stale-unlink) ALSO throws EEXIST to exercise its catch branch.
    let callCount = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(
          (
            path: fsModule.PathLike,
            flags: fsModule.OpenMode,
            mode?: fsModule.Mode | null,
          ): number => {
            // Only intercept opens of the lock path with the 'wx' flag (the
            // exclusive-create path that drives acquireLock + retryOnce).
            // All other opens (readJson, fsync on dir, etc.) pass through.
            if (typeof path === 'string' && path === lockPath && flags === 'wx') {
              callCount++;
              const err = new Error('file exists') as NodeJS.ErrnoException;
              err.code = 'EEXIST';
              throw err;
            }
            return actual.openSync(path, flags, mode);
          },
        ),
      };
    });
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    // Both openSync('wx') attempts went through the mock.
    expect(callCount).toBe(2);
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
  });

  it('recovers from a vanished-file race (readFileSync throws ENOENT during stale check)', async () => {
    // Spy on readFileSync to throw ENOENT on the lockfile read inside
    // checkStaleAndRetry. The catch sets pidStr = '', parseInt yields NaN,
    // unlinkIfSamePid('') is called; its readFileSync also fails (file truly
    // gone) so it returns false. Skip line fires, null returned. The file
    // never existed for the test to inspect; assert only the null return and
    // the stderr line. This exercises the line-296 catch branch.
    // Use vi.doMock so the spied-fs is in scope during dynamic import.
    mkdirSync(lockDir, { recursive: true });
    // No actual lock file - openSync('wx') would normally succeed. Force
    // EEXIST so checkStaleAndRetry is invoked.
    let openCount = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(
          (
            path: fsModule.PathLike,
            flags: fsModule.OpenMode,
            mode?: fsModule.Mode | null,
          ): number => {
            if (typeof path === 'string' && path === lockPath && flags === 'wx') {
              openCount++;
              const err = new Error('file exists') as NodeJS.ErrnoException;
              err.code = 'EEXIST';
              throw err;
            }
            return actual.openSync(path, flags, mode);
          },
        ),
        readFileSync: vi.fn(
          (
            path: fsModule.PathOrFileDescriptor,
            opts?: Parameters<typeof actual.readFileSync>[1],
          ) => {
            if (typeof path === 'string' && path === lockPath) {
              const err = new Error('no such file') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            return actual.readFileSync(path, opts);
          },
        ),
      };
    });
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(openCount).toBe(1);
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
  });

  it('rethrows when openSync fails with a non-EEXIST error (e.g. EACCES on parent dir)', async () => {
    // acquireLock catches openSync errors and only converts EEXIST into the
    // contention-recovery path. Any other code (EACCES, ENOSPC, etc.) must
    // be rethrown unchanged so the caller sees the underlying I/O failure.
    // Covers the line-233 truthy `code !== 'EEXIST'` rethrow branch.
    mkdirSync(lockDir, { recursive: true });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(
          (
            path: fsModule.PathLike,
            flags: fsModule.OpenMode,
            mode?: fsModule.Mode | null,
          ): number => {
            if (typeof path === 'string' && path === lockPath && flags === 'wx') {
              const err = new Error('permission denied') as NodeJS.ErrnoException;
              err.code = 'EACCES';
              throw err;
            }
            return actual.openSync(path, flags, mode);
          },
        ),
      };
    });
    const { acquireLock } = await import('./utils.ts');
    expect(() => acquireLock('pull')).toThrow(/permission denied/);
  });

  it('returns null after ESRCH liveness probe when unlinkIfSamePid cannot remove the stale lock', async () => {
    // Plant a dead PID so process.kill(pid, 0) throws ESRCH. Then mock
    // unlinkSync to throw EACCES so unlinkIfSamePid (line 280) returns
    // false. Control flow lands on the post-ESRCH fallthrough at lines
    // 312-313 (stderr skip + null return) WITHOUT retrying. Distinct from
    // the successful-ESRCH-recovery path covered by utils.test.ts.
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
        // Allow openSync('wx') to throw EEXIST naturally (the planted file
        // is on disk), then block unlinkSync so unlinkIfSamePid bails with
        // false at line 280's catch.
        unlinkSync: vi.fn((path: fsModule.PathLike) => {
          if (typeof path === 'string' && path === lockPath) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return actual.unlinkSync(path);
        }),
      };
    });
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    // Lockfile remains because unlink was blocked.
    expect(existsSync(lockPath)).toBe(true);
  });
});
