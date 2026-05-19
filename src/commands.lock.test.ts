import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as childProcessModule from 'node:child_process';
import type * as utilsModule from './utils.ts';

// Regression: cmdPull and cmdPush must release the lockfile even when a
// fatal error fires mid-flight. Earlier code path called process.exit()
// from die(), which skipped the try/finally and left a stale lock holding
// the now-dead PID.
describe('cmdPull / cmdPush lock release on fatal', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lock-fatal-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(repoUnderHome, { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
    // Suppress noisy fatal output during the test.
    vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((_chunk) => true);
    vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./push-checks.ts');
    vi.doUnmock('./remap.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('releases the lockfile when cmdPull dies because shared/settings.base.json is missing', async () => {
    // shared/ dir exists but settings.base.json is absent. regenerateSettings
    // will call die(), which throws NomadFatal; cmdPull's catch sets exitCode
    // and the finally must release the lock.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    // No `.git` so `git pull --rebase --autostash` would fail too. To isolate
    // the die() path, mock execFileSync at the `node:child_process` level so
    // cmdPull's inline argv-array rebase call is a no-op for this test. Same
    // mock-via-importOriginal shape as the cmdPush-NEVER_SYNC test below.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPull dies because the backup parent path is a file (mkdir ENOTDIR)', async () => {
    // Pre-create ~/.cache/claude-nomad/backup as a regular FILE. acquireLock
    // creates the parent dir; freshBackupTs only reads. mkdirSync(backupRoot,
    // recursive: true) then fails with ENOTDIR because it tries to descend
    // into a file. cmdPull's catch turns it into a fatal exit + lock release.
    const cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'backup'), '');
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPull catches a non-NomadFatal error and rethrows', async () => {
    // Mock applySharedLinks to throw a TypeError (non-NomadFatal). cmdPull's
    // catch should rethrow, but finally still releases the lock.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(() => {
        throw new TypeError('synthetic non-NomadFatal');
      }),
      regenerateSettings: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).toThrow(TypeError);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush rejects a NEVER_SYNC entry via enforceAllowList', async () => {
    // Build a repo state where `git status --porcelain=v1 -z` would emit a
    // NEVER_SYNC path. Stub gitStatusPorcelainZ (the shell-free helper cmdPush
    // routes through) to return the porcelain we want.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? .claude.json\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush dies on missing path-map.json', async () => {
    // Stub probeGitleaks / rebaseBeforePush / remapPush so the pre-checks
    // succeed; gitStatusPorcelainZ returns a non-empty status so the
    // empty-status early return is bypassed; path-map.json absent on disk
    // triggers `die('path-map.json missing...')`. cmdPush's catch sets
    // exitCode and finally releases the lock.
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush dies on malformed path-map.json (parse failure)', async () => {
    // path-map.json present but readJson throws SyntaxError. cmdPush wraps
    // it in NomadFatal; the catch block sets exitCode and finally releases
    // the lock. Mock push-checks/remap so the pre-checks no-op, and mock
    // readJson on utils to deterministically throw.
    writeFileSync(join(repoUnderHome, 'path-map.json'), '{');
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
        readJson: vi.fn(() => {
          throw new SyntaxError('Unexpected end of JSON input');
        }),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush catches a non-NomadFatal error and rethrows', async () => {
    // Mock runGitleaksScan to throw a TypeError (non-NomadFatal). cmdPush's
    // catch rethrows, but finally still releases the lock.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
      runGitleaksScan: vi.fn(() => {
        throw new TypeError('synthetic non-NomadFatal');
      }),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).toThrow(TypeError);
    expect(existsSync(lockPath)).toBe(false);
  });
});
