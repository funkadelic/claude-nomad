import {
  existsSync,
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
 * Split off from utils.lockfile.test.ts to keep file sizes under the
 * ~200-line cap. Part 1 of the stale-lock recovery branches: the
 * non-numeric-PID and live-PID (EPERM) paths plus the lost-retry race in
 * `checkStaleAndRetry` / `reapIfSamePid` / `retryOnce`. Part 2
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

  it('returns null and writes stderr skip line when PID is non-numeric AND the stale-lock rename fails', async () => {
    // Pre-write a non-numeric PID so parseInt fails (NaN, not finite).
    // Mock renameSync to throw EACCES for the lock path so reapIfSamePid
    // returns false. The fallthrough lands on the stderr skip line, returning
    // null without recovering. Mock-based (vs chmod) for determinism across
    // root-owned CI containers where POSIX bits do not bind.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, 'not-a-pid');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        renameSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof from === 'string' && from === lockPath) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return actual.renameSync(from, to);
        }),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(readFileSync(lockPath, 'utf8')).toBe('not-a-pid');
    expect(readdirSync(lockDir)).toEqual(['nomad.lock']);
  });

  it('recovers and retries successfully when PID is non-numeric AND unlink succeeds', async () => {
    // Empty string -> parseInt('') is NaN -> !Number.isFinite(pid) true ->
    // reapIfSamePid('') compares the grave's trimmed content '' and removes
    // it. retryOnce then publishes the lock fresh with our PID.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '');
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8').split(' ')[0]).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(lockDir)).toEqual([]);
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

  it('returns null when a contender takes the lock between the stale reap and the retry', async () => {
    // Plant a dead PID so the ESRCH branch reaps the stale lock. Then a
    // contender (simulated inside the retry's linkSync) creates the lock just
    // before our publish, so the link fails EEXIST and retryOnce skips.
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
        linkSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (
            typeof from === 'string' &&
            typeof to === 'string' &&
            to === lockPath &&
            from.endsWith('.tmp') &&
            !actual.existsSync(lockPath)
          ) {
            actual.writeFileSync(lockPath, String(process.pid));
          }
          return actual.linkSync(from, to);
        }),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(readdirSync(lockDir)).toEqual(['nomad.lock']);
  });
});
