import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsModule from './utils.ts';

// CR-01 regression: cmdPull and cmdPush must release the lockfile even when
// a fatal error fires mid-flight. Pre-fix, die() called process.exit() which
// skipped the try/finally and left a stale lock holding the now-dead PID.
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
    // No `.git` so `git pull --rebase` would fail too. To isolate the die()
    // path, stub `sh` via mocking the utils module's sh export. Simpler: skip
    // the git step by pre-creating .git/config to a usable state? Cleaner is
    // to stub sh.
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, sh: vi.fn(() => '') };
    });
    const { cmdPull } = await import('./commands.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(1);
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
    const { cmdPush } = await import('./commands.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
