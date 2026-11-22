import {
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
 * Part 2 of the stale-lock recovery branches, split from
 * utils.lockfile.recovery.test.ts to keep both files under the ~200-line
 * cap. Covers the vanished-file ENOENT race, the non-EEXIST publish rethrow,
 * the post-ESRCH rename-failure fallthrough, and the reap races (a live lock
 * moved by the reap is restored; a third contender in the restore gap wins
 * without leaving a grave). SUT loads from ./utils.lockfile.ts.
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

  it('recovers from a vanished-file race (lock reported as existing but absent on disk)', async () => {
    // The publish link reports EEXIST although no lock file exists, so the
    // stale read fails with ENOENT, pidStr is '', and the reap's rename fails
    // too. Skip line fires, null returned, nothing is left behind.
    mkdirSync(lockDir, { recursive: true });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        linkSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof to === 'string' && to === lockPath) {
            const err = new Error('file exists') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
          return actual.linkSync(from, to);
        }),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('rethrows when the publish step fails with a non-EEXIST error (e.g. EACCES)', async () => {
    // Only EEXIST routes into contention recovery. Any other code (EACCES,
    // ENOSPC, etc.) must be rethrown unchanged after the temp file is cleaned.
    mkdirSync(lockDir, { recursive: true });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        linkSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof to === 'string' && to === lockPath) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return actual.linkSync(from, to);
        }),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(() => acquireLock('pull')).toThrow(/permission denied/);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  it('returns null after ESRCH liveness probe when the stale-lock rename fails', async () => {
    // Plant a dead PID so process.kill(pid, 0) throws ESRCH. Then mock
    // renameSync to throw EACCES so reapIfSamePid returns false. Control flow
    // lands on the post-ESRCH fallthrough (skip line + null) WITHOUT retrying.
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
    expect(readFileSync(lockPath, 'utf8')).toBe(String(deadPid));
    expect(readdirSync(lockDir)).toEqual(['nomad.lock']);
  });

  it('restores a live lock that the reap moved to its grave', async () => {
    // Dead PID planted; just before our rename a contender reaps it and takes
    // the lock (simulated by overwriting the path with a live PID). The reap
    // moves that live lock, sees the PID mismatch, and restores it intact.
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
        renameSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof from === 'string' && from === lockPath) {
            actual.writeFileSync(lockPath, String(process.pid));
          }
          return actual.renameSync(from, to);
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

  it('leaves no grave when a third contender takes the lock path before the restore', async () => {
    // Same moved-live-lock setup, but another process grabs the lock path in
    // the gap before the restore link, so the restore fails EEXIST. Their
    // lock stays and the grave is removed.
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
        renameSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof from === 'string' && from === lockPath) {
            actual.writeFileSync(lockPath, String(process.pid));
          }
          return actual.renameSync(from, to);
        }),
        linkSync: vi.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
          if (typeof from === 'string' && from.endsWith('.stale')) {
            actual.writeFileSync(lockPath, String(process.ppid));
          }
          return actual.linkSync(from, to);
        }),
      };
    });
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.ppid));
    expect(readdirSync(lockDir)).toEqual(['nomad.lock']);
  });
});
