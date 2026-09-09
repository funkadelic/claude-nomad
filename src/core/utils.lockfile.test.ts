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
 * Lockfile happy-path + release error-propagation coverage, mirroring the
 * utils.lockfile.ts source module. The stale-lock recovery branches live in
 * the sibling utils.lockfile.recovery.test.ts to keep both files under the
 * ~200-line cap. SUT symbols load from ./utils.lockfile.ts.
 */
describe('acquireLock / releaseLock', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    stderrWrites = [];
    // warn() routes through console.error; capture both stdio paths so the
    // lock-contention assertions remain stream-agnostic across the helper
    // refactor (process.stderr.write is still spied for defense in depth).
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
    try {
      unlinkSync(lockPath);
    } catch {
      /* defensive cleanup; ignore */
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('fresh acquire creates lockfile with our PID, release removes it', async () => {
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null and writes stderr skip line when a live PID owns the lock', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    const { acquireLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('unlinks stale lockfile and retries when PID file references a dead process', async () => {
    const deadPid = 2147483647;
    let guarded = false;
    try {
      process.kill(deadPid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') guarded = true;
    }
    if (!guarded) {
      throw new Error(
        `PID ${deadPid} unexpectedly live on this host; raise pid_max guard or pick a higher PID.`,
      );
    }
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(lockPath, String(deadPid));
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null on double-acquire in the same process (own PID is alive)', async () => {
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const first = acquireLock('pull');
    expect(first).not.toBeNull();
    const second = acquireLock('pull');
    expect(second).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    releaseLock(first);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releaseLock(null) is a safe no-op', async () => {
    const { releaseLock } = await import('./utils.lockfile.ts');
    expect(() => releaseLock(null)).not.toThrow();
    expect(existsSync(join(testHome, '.cache', 'claude-nomad'))).toBe(false);
  });
});

describe('releaseLock error propagation', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-release-rethrow-'));
    process.env.HOME = testHome;
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('rethrows when unlinkSync fails with a non-ENOENT error (e.g. EACCES)', async () => {
    // releaseLock tolerates ENOENT (lockfile already gone) but rethrows
    // everything else so the caller surfaces unexpected I/O failures.
    // Mock node:fs.unlinkSync to throw EACCES for the lockfile path; the
    // `code !== 'ENOENT'` true branch in releaseLock is exercised.
    // Done via vi.doMock (rather than spyOn) because ESM module namespaces
    // are not configurable.
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
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(() => releaseLock(handle)).toThrow(/permission denied/);
  });

  it('silently tolerates ENOENT on unlinkSync (lockfile already vanished)', async () => {
    // ENOENT branch of releaseLock's unlink catch: the lockfile is gone
    // before we get to unlink it (e.g. another process cleaned up first).
    // Must NOT throw - this is the documented tolerance contract.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        unlinkSync: vi.fn((path: fsModule.PathLike) => {
          if (typeof path === 'string' && path === lockPath) {
            const err = new Error('no such file') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          }
          return actual.unlinkSync(path);
        }),
      };
    });
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    // Silent: no throw despite the simulated vanish.
    expect(() => releaseLock(handle)).not.toThrow();
  });
});
