import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';

/**
 * Sibling file to utils.test.ts. Covers two small uncovered branches that
 * did not need to live in the main file:
 *   - ensureSymlink die-when-not-a-symlink branch
 *   - releaseLock rethrow on non-ENOENT unlink failure
 *
 * Split so utils.test.ts stays at its prior size; the ~200-line cap is
 * already a soft ceiling that utils.test.ts has historically exceeded for
 * legacy reasons, and adding to it would worsen the violation.
 */

describe('ensureSymlink', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nomad-ensuresymlink-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('dies when the link path exists as a regular file (not a symlink)', async () => {
    const { ensureSymlink, NomadFatal } = await import('./utils.ts');
    const target = join(testDir, 'target.txt');
    const linkPath = join(testDir, 'link');
    writeFileSync(target, 'target-content');
    // Plant a regular file (not symlink) at linkPath. ensureSymlink must
    // refuse to overwrite via die() rather than clobber the file.
    writeFileSync(linkPath, 'pre-existing regular file');
    expect(() => ensureSymlink(linkPath, target)).toThrow(NomadFatal);
    expect(() => ensureSymlink(linkPath, target)).toThrow(/exists and is not a symlink/);
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
    const { acquireLock, releaseLock } = await import('./utils.ts');
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
    const { acquireLock, releaseLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    // Silent: no throw despite the simulated vanish.
    expect(() => releaseLock(handle)).not.toThrow();
  });
});
