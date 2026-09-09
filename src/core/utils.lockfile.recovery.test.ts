import {
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
 * Split off from utils.lockfile.test.ts to keep file sizes under the
 * ~200-line cap. Part 1 of the stale-lock recovery branches: the
 * non-numeric-PID and live-PID (EPERM) paths plus the retryOnce(EEXIST)
 * race in `checkStaleAndRetry` / `unlinkIfSamePid` / `retryOnce`. Part 2
 * lives in utils.lockfile.recovery2.test.ts. SUT loads from
 * ./utils.lockfile.ts.
 */
describe('acquireLock stale-lock recovery branches (part 1)', () => {
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

  it('returns null and writes stderr skip line when PID is non-numeric AND unlink fails', async () => {
    // Pre-write a non-numeric PID so parseInt fails (NaN, not finite).
    // Mock unlinkSync to throw EACCES for the lock path so unlinkIfSamePid
    // returns false. The fallthrough lands on the stderr skip line, returning
    // null without recovering. Mock-based (vs chmod) for determinism across
    // root-owned CI containers where POSIX bits do not bind.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, 'not-a-pid');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
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
    expect(existsSync(lockPath)).toBe(true);
  });

  it('recovers and retries successfully when PID is non-numeric AND unlink succeeds', async () => {
    // Empty string -> parseInt('') is NaN -> !Number.isFinite(pid) true ->
    // unlinkIfSamePid('') compares against the file's trimmed content '' and
    // unlinks it. retryOnce then opens the lock fresh and writes our PID.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '');
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
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
    const { acquireLock } = await import('./utils.lockfile.ts');
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
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    // Both openSync('wx') attempts went through the mock.
    expect(callCount).toBe(2);
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
  });
});
