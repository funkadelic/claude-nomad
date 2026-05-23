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

// Extras integration in cmdPull. Three insertion points are exercised:
//   1. divergenceCheckExtras runs immediately AFTER `git pull --rebase` and
//      BEFORE any local mutation, so its WARN output is the user's signal
//      that a subsequent remapExtrasPull will clobber local edits.
//   2. remapExtrasPull runs in the wet-mutation `else` branch AFTER
//      `remapPull(ts)` and BEFORE `log('pull complete')`. The dry-run
//      branch deliberately skips it (per the plan; preserves the
//      zero-mutation contract).
//   3. emitSummary in the wet path carries `extrasResult.skipped` as the
//      fourth positional argument.
describe('cmdPull: extras integration', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedExtras: string;
  let projectRoot: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-extras-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedExtras = join(repoUnderHome, 'shared', 'extras');
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(sharedExtras, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
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
    vi.doUnmock('./links.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.doUnmock('./preview.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('calls divergenceCheckExtras after git pull --rebase and before remapExtrasPull', async () => {
    // Track relative order of the three new pipeline steps. The plan's
    // required order: gitOrFatal('pull') -> divergenceCheckExtras ->
    // applySharedLinks/regenerateSettings -> remapPull -> remapExtrasPull.
    const callOrder: string[] = [];
    const divergenceCheckExtrasMock = vi.fn(() => {
      callOrder.push('divergenceCheckExtras');
    });
    const remapExtrasPullMock = vi.fn(() => {
      callOrder.push('remapExtrasPull');
      return { unmapped: 0, skipped: 0 };
    });
    const remapPullMock = vi.fn(() => {
      callOrder.push('remapPull');
      return { unmapped: 0 };
    });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: remapPullMock,
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: remapExtrasPullMock,
      divergenceCheckExtras: divergenceCheckExtrasMock,
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: vi.fn(() => {
          callOrder.push('gitOrFatal');
        }),
      };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(divergenceCheckExtrasMock).toHaveBeenCalled();
    expect(remapExtrasPullMock).toHaveBeenCalled();
    // Required call-order: pull --rebase -> divergenceCheckExtras (BEFORE
    // any mutation) -> remapPull -> remapExtrasPull.
    expect(callOrder).toEqual([
      'gitOrFatal',
      'divergenceCheckExtras',
      'remapPull',
      'remapExtrasPull',
    ]);
  });

  it('passes ts as a string to remapExtrasPull (matches the remap.ts ts contract)', async () => {
    const remapExtrasPullMock = vi.fn(() => ({ unmapped: 0, skipped: 0 }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0 })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: remapExtrasPullMock,
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(remapExtrasPullMock).toHaveBeenCalledWith(expect.any(String));
  });

  it('dry-run skips remapExtrasPull but still runs divergenceCheckExtras (D-08 read-only contract)', async () => {
    // Per the plan: dryRun preserves the zero-mutation contract by skipping
    // remapExtrasPull entirely, but divergenceCheckExtras still fires
    // because it is read-only and the user wants to see the same
    // pre-pull WARN in both wet and dry modes.
    const divergenceCheckExtrasMock = vi.fn();
    const remapExtrasPullMock = vi.fn(() => ({ unmapped: 0, skipped: 0 }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0 })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: remapExtrasPullMock,
      divergenceCheckExtras: divergenceCheckExtrasMock,
    }));
    vi.doMock('./preview.ts', () => ({
      computePreview: vi.fn(() => ({ unmapped: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull({ dryRun: true })).not.toThrow();
    expect(divergenceCheckExtrasMock).toHaveBeenCalled();
    expect(remapExtrasPullMock).not.toHaveBeenCalled();
    vi.doUnmock('./preview.ts');
  });

  it('legacy path-map.json without extras key: divergenceCheckExtras and remapExtrasPull are still invoked (they no-op internally)', async () => {
    // D-03 additive contract: the call sites in cmdPull always fire; the
    // extras-sync functions themselves return early when no extras key is
    // present (covered by extras-sync.test.ts). cmdPull does not branch
    // on the presence of the extras key.
    const divergenceCheckExtrasMock = vi.fn();
    const remapExtrasPullMock = vi.fn(() => ({ unmapped: 0, skipped: 0 }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0 })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: remapExtrasPullMock,
      divergenceCheckExtras: divergenceCheckExtrasMock,
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(divergenceCheckExtrasMock).toHaveBeenCalled();
    expect(remapExtrasPullMock).toHaveBeenCalled();
  });

  it('passes extrasResult.skipped to emitSummary on the wet-mutation pull success path', async () => {
    // skipped=3 from remapExtrasPull should surface in the pull WARN line
    // as "3 extras skipped".
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['node_modules', '.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0 })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 3 })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const errSpyLocal = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    const combined = errSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('3 extras skipped');
  });
});
