import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Part 2 of the stale-lock recovery branches, split from
 * utils.lockfile.recovery.test.ts to keep both files under the ~200-line
 * cap. Covers the vanished-file ENOENT race, the non-EEXIST openSync
 * rethrow, and the post-ESRCH unlink-failure fallthrough. SUT loads from
 * ./utils.lockfile.ts.
 */
describe('acquireLock stale-lock recovery branches (part 2)', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockDir: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lockfile-test2-'));
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
    const { acquireLock } = await import('./utils.lockfile.ts');
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
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(() => acquireLock('pull')).toThrow(/permission denied/);
  });

  it('returns null after ESRCH liveness probe when unlinkIfSamePid cannot remove the stale lock', async () => {
    // Plant a dead PID so process.kill(pid, 0) throws ESRCH. Then mock
    // unlinkSync to throw EACCES so unlinkIfSamePid (line 280) returns
    // false. Control flow lands on the post-ESRCH fallthrough at lines
    // 312-313 (stderr skip + null return) WITHOUT retrying. Distinct from
    // the successful-ESRCH-recovery path covered by utils.lockfile.test.ts.
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
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    // Lockfile remains because unlink was blocked.
    expect(existsSync(lockPath)).toBe(true);
  });
});
