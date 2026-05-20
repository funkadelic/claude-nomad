import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsModule from './utils.ts';

/**
 * Covers the two scattered branches in cmdPull that the existing
 * commands.lock.test.ts does not hit directly:
 *   - line 34: `if (!existsSync(REPO_HOME)) die('repo not cloned at ${REPO_HOME}')`
 *   - line 43: `if (handle === null) process.exit(0)` (lock-contention skip)
 *
 * commands.lock.test.ts covers the post-acquire lock release paths and the
 * unscaffolded-repo precondition (settings.base.json absent). These tests
 * exercise the BEFORE-acquireLock precondition (REPO_HOME absent) and the
 * AFTER-acquireLock contention skip.
 */
describe('cmdPull precondition and lock-contention branches', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    vi.resetModules();
    // Capture stderr/console output without polluting test logs.
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('dies with "repo not cloned at" FATAL when REPO_HOME does not exist on disk', async () => {
    // Note: repoUnderHome was NOT created in beforeEach for this test scope.
    // The precondition (line 34) must fire BEFORE acquireLock, so no lockfile
    // is ever created on disk.
    expect(existsSync(repoUnderHome)).toBe(false);
    const { cmdPull } = await import('./commands.pull.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdPull()).toThrow(NomadFatal);
    expect(() => cmdPull()).toThrow(/repo not cloned at/);
    expect(() => cmdPull()).toThrow(repoUnderHome);
    // Critical: the precondition fires before acquireLock, so no lockfile
    // exists. If a future refactor moves the check after acquireLock, this
    // assertion catches it.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('honors the lock-contention skip path (process.exit(0)) when acquireLock returns null', async () => {
    // Scaffold a minimally-valid repo so both REPO_HOME and settings.base.json
    // preconditions pass; the flow then reaches acquireLock, which our mock
    // forces to return null. Line 43's `if (handle === null) process.exit(0)`
    // should fire. Spy on process.exit to convert the call into a throw so
    // the test can assert on it without actually exiting the runner.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const acquireSpy = vi.fn(() => null);
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).toThrow(/process\.exit:0/);
    expect(acquireSpy).toHaveBeenCalledWith('pull');
    expect(exitSpy).toHaveBeenCalledWith(0);
    // No lockfile because the mock acquireLock returned null without writing.
    expect(existsSync(lockPath)).toBe(false);
  });
});
