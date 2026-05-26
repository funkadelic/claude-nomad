import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as lockfileModule from './utils.lockfile.ts';

// Covers the lock-contention skip path for cmdPush, symmetric to cmdPull's
// contention skip covered in commands.pull.test.ts. acquireLock returns null
// -> process.exit(0) before the try block (no NomadFatal, no exitCode=1).
describe('cmdPush lock-contention skip path', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpush-lockskip-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(repoUnderHome, { recursive: true });
    vi.resetModules();
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
    vi.doUnmock('./utils.lockfile.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('calls process.exit(0) when acquireLock returns null', async () => {
    // Spy on process.exit so the test can assert on it without exiting.
    // Mock acquireLock to return null; cmdPush should then exit(0) before
    // entering the try block (no NomadFatal, no exitCode=1).
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const acquireSpy = vi.fn(() => null);
    vi.doMock('./utils.lockfile.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof lockfileModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).toThrow(/process\.exit:0/);
    expect(acquireSpy).toHaveBeenCalledWith('push');
    expect(exitSpy).toHaveBeenCalledWith(0);
    // No real lockfile because the mock never wrote one.
    expect(existsSync(lockPath)).toBe(false);
  });
});
