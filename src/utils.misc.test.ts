import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('backupExtrasWrite', () => {
  // Symmetric with backupBeforeWrite / backupRepoWrite tests: the new helper
  // snapshots a path OUTSIDE CLAUDE_HOME (project-attached extras live at a
  // project root on the host filesystem), so the existing helpers' relative()
  // guard would silently no-op. backupExtrasWrite takes an explicit
  // projectRoot anchor and writes to ~/.cache/claude-nomad/backup/<ts>/extras/.
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let projectRoot: string;
  let cacheBase: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-backup-extras-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(projectRoot, { recursive: true });
    cacheBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('snapshots a single file to the extras-prefixed backup root, namespaced by projectRoot', async () => {
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(planningDir, { recursive: true });
    const src = join(planningDir, 'PLAN.md');
    writeFileSync(src, '# plan content\n');

    const { backupExtrasWrite, encodePath } = await import('./utils.ts');
    backupExtrasWrite(src, '20260522-100000', projectRoot);

    const backupFile = join(
      cacheBase,
      '20260522-100000',
      'extras',
      encodePath(projectRoot),
      '.planning',
      'PLAN.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# plan content\n');
  });

  it('recursively snapshots a directory tree under the encoded-projectRoot namespace', async () => {
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(join(planningDir, 'phases', '01'), { recursive: true });
    writeFileSync(join(planningDir, 'STATE.md'), 'state\n');
    writeFileSync(join(planningDir, 'phases', '01', 'PLAN.md'), 'plan\n');

    const { backupExtrasWrite, encodePath } = await import('./utils.ts');
    backupExtrasWrite(planningDir, '20260522-100001', projectRoot);

    const backupRoot = join(
      cacheBase,
      '20260522-100001',
      'extras',
      encodePath(projectRoot),
      '.planning',
    );
    expect(existsSync(join(backupRoot, 'STATE.md'))).toBe(true);
    expect(readFileSync(join(backupRoot, 'STATE.md'), 'utf8')).toBe('state\n');
    expect(existsSync(join(backupRoot, 'phases', '01', 'PLAN.md'))).toBe(true);
    expect(readFileSync(join(backupRoot, 'phases', '01', 'PLAN.md'), 'utf8')).toBe('plan\n');
  });

  it('does not collide when two projectRoots share the same relative extras path', async () => {
    // Without the encodePath(projectRoot) namespace, `backup/<ts>/extras/<rel>`
    // collides whenever two opted-in projects pull simultaneously with the
    // same relative extras tree. `cpSync` runs with `force: false`, so the
    // second snapshot would silently drop and the user would lose recovery
    // coverage for one of the two projects.
    const projectRootB = join(testHome, 'fake-project-b');
    mkdirSync(join(projectRootB, '.planning'), { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'A\n');
    writeFileSync(join(projectRootB, '.planning', 'PLAN.md'), 'B\n');

    const { backupExtrasWrite, encodePath } = await import('./utils.ts');
    backupExtrasWrite(join(projectRoot, '.planning', 'PLAN.md'), '20260522-100004', projectRoot);
    backupExtrasWrite(join(projectRootB, '.planning', 'PLAN.md'), '20260522-100004', projectRootB);

    const aBackup = join(
      cacheBase,
      '20260522-100004',
      'extras',
      encodePath(projectRoot),
      '.planning',
      'PLAN.md',
    );
    const bBackup = join(
      cacheBase,
      '20260522-100004',
      'extras',
      encodePath(projectRootB),
      '.planning',
      'PLAN.md',
    );
    expect(readFileSync(aBackup, 'utf8')).toBe('A\n');
    expect(readFileSync(bBackup, 'utf8')).toBe('B\n');
  });

  it('no-ops when the source path does not exist', async () => {
    const missing = join(projectRoot, '.planning', 'never-existed.md');

    const { backupExtrasWrite } = await import('./utils.ts');
    expect(() => backupExtrasWrite(missing, '20260522-100002', projectRoot)).not.toThrow();

    expect(existsSync(join(cacheBase, '20260522-100002'))).toBe(false);
  });

  it('no-ops when absPath resolves outside projectRoot', async () => {
    // path.relative(projectRoot, '/some/other/path') returns a ..-prefixed
    // string. The helper must detect that and return silently, matching the
    // existing backupBeforeWrite / backupRepoWrite contract.
    const outside = join(testHome, 'unrelated', 'thing.md');
    mkdirSync(join(testHome, 'unrelated'), { recursive: true });
    writeFileSync(outside, 'unrelated\n');

    const { backupExtrasWrite } = await import('./utils.ts');
    expect(() => backupExtrasWrite(outside, '20260522-100003', projectRoot)).not.toThrow();

    expect(existsSync(join(cacheBase, '20260522-100003'))).toBe(false);
  });
});
