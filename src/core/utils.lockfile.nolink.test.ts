import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Lockfile behavior on a filesystem without hard links: every `linkSync`
 * fails with EPERM, so create falls back to an exclusive open and a restore
 * falls back to a rename.
 */
describe('lockfile without hard links', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-nolink-'));
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

  /**
   * Mock node:fs so `linkSync` always fails with EPERM, and optionally fail
   * the Nth numeric-fd `writeFileSync`.
   *
   * @param failWriteCall 1-based numeric-fd write to fail, or 0 for none.
   */
  function mockNoHardLinks(failWriteCall = 0): void {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      let fdWrites = 0;
      return {
        ...actual,
        linkSync: vi.fn(() => {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }),
        writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => {
          if (typeof args[0] === 'number' && ++fdWrites === failWriteCall) {
            const err = new Error('no space left') as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            throw err;
          }
          return actual.writeFileSync(...args);
        }),
      };
    });
  }

  it('acquires with an exclusive create and releases cleanly', async () => {
    mockNoHardLinks();
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8').split(' ')[0]).toBe(String(process.pid));
    releaseLock(handle);
    expect(readdirSync(dirname(lockPath))).toEqual([]);
  });

  it('rethrows a fallback write failure and leaves no lockfile', async () => {
    // First fd write is the tmp (then the link fails); the second is the fallback.
    mockNoHardLinks(2);
    const { acquireLock } = await import('./utils.lockfile.ts');
    expect(() => acquireLock('pull')).toThrow(/no space left/);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(dirname(lockPath))).toEqual([]);
  });

  it('release renames a lock it does not own back into place', async () => {
    mockNoHardLinks();
    const { acquireLock, releaseLock } = await import('./utils.lockfile.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    // Another contender took the path after ours was moved away.
    unlinkSync(lockPath);
    writeFileSync(lockPath, '424242');
    releaseLock(handle);
    expect(readFileSync(lockPath, 'utf8')).toBe('424242');
    expect(readdirSync(dirname(lockPath))).toEqual(['nomad.lock']);
  });
});
