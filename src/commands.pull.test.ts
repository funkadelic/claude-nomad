import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as wedgeModule from './commands.pull.wedge.ts';

import type * as utilsModule from './utils.ts';
import type * as lockfileModule from './utils.lockfile.ts';

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
    vi.doUnmock('./utils.lockfile.ts');
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
    vi.doMock('./utils.lockfile.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof lockfileModule>();
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
      return { unmapped: 0, skipped: 0, pulled: [], wouldPull: [] };
    });
    const remapPullMock = vi.fn(() => {
      callOrder.push('remapPull');
      return { unmapped: 0, pulled: [], wouldPull: [] };
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
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
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
    const remapExtrasPullMock = vi.fn(() => ({
      unmapped: 0,
      skipped: 0,
      pulled: [],
      wouldPull: [],
    }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
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
    // remapExtrasPull receives ts as the first arg; second arg opts may contain
    // prePostHeads (undefined here because gitOrFatal mock replaces git ops).
    expect(remapExtrasPullMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
  });

  it('dry-run skips remapExtrasPull but still runs divergenceCheckExtras (D-08 read-only contract)', async () => {
    // Per the plan: dryRun preserves the zero-mutation contract by skipping
    // remapExtrasPull entirely, but divergenceCheckExtras still fires
    // because it is read-only and the user wants to see the same
    // pre-pull WARN in both wet and dry modes.
    const divergenceCheckExtrasMock = vi.fn();
    const remapExtrasPullMock = vi.fn(() => ({
      unmapped: 0,
      skipped: 0,
      pulled: [],
      wouldPull: [],
    }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
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
    const remapExtrasPullMock = vi.fn(() => ({
      unmapped: 0,
      skipped: 0,
      pulled: [],
      wouldPull: [],
    }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
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

  it('surfaces extrasResult.skipped in the WET-pull Summary row of the grouped tree', async () => {
    // skipped=3 from remapExtrasPull surfaces in the in-tree Summary row as
    // "3 extras skipped". On the WET path the summary renders through the
    // grouped tree (summaryRow via console.log / stdout), not the standalone
    // emitSummary warn() on stderr; the phrasing is preserved.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['node_modules', '.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 3, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    const combined = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('Summary');
    expect(combined).toContain('3 extras skipped');
  });

  it('renders the WET grouped tree: header, Settings row, pulled ✓ rows, and the collapsed unmapped count', async () => {
    // WET-path coverage: a pulled session, a pulled extra, plus one unmapped
    // entry exercise every tree builder. The header, Settings row, both ✓
    // item rows, and the collapsed `1 not in path-map` row must all render
    // through console.log (stdout) and `pull complete` must be gone.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 1, pulled: ['proj-a'], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({
        unmapped: 0,
        skipped: 0,
        pulled: ['proj-a/.planning'],
        wouldPull: [],
      })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    const out = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(out).toContain('pull on host=');
    expect(out).toContain('Settings');
    expect(out).toMatch(/✓ +settings\.json \(base \+ no host overrides\)/);
    expect(out).toContain('Sessions');
    expect(out).toMatch(/✓ +proj-a/);
    expect(out).toContain('1 not in path-map (run nomad doctor to list)');
    expect(out).toContain('Extras');
    expect(out).toMatch(/✓ +proj-a\/\.planning/);
    expect(out).toContain('Summary');
    expect(out).not.toContain('pull complete');
  });

  it('summaryRow receives the SUM of remapResult.unmapped + extrasResult.unmapped (L49 ArithmeticOperator)', async () => {
    // Both remap and extras report unmapped > 0. The collapsed summary count
    // must equal 2+3=5, not 2-3=-1 (the ArithmeticOperator + -> - mutation).
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot }, bar: { 'other-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 2, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 3, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    const out = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    // Sum is 5; a subtraction mutation would yield -1 and render "-1 unmapped on pull"
    // or "clean" (negative unmapped collapses), never "5 unmapped on pull".
    expect(out).toContain('5 unmapped on pull');
  });

  it('renders the WET grouped tree with a host-override Settings label and zero-skip Sessions', async () => {
    // Settings-with-override label branch ('<HOST>.json') plus a pulled
    // session with unmapped==0 (no collapsed count row). Covers the
    // settings-with-override label and the zero-skip Sessions branch.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'test-host.json' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: ['proj-a'], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    const out = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(out).toMatch(/✓ +settings\.json \(base \+ test-host\.json\)/);
    expect(out).toMatch(/✓ +proj-a/);
    // Zero unmapped means no collapsed count row, and no Extras section.
    expect(out).not.toContain('not in path-map');
    expect(out).not.toContain('Extras');
    // Clean summary (no unmapped, no extras skipped).
    expect(out).toContain('clean');
  });
});

// ---------------------------------------------------------------------------
// Wedge preflight guard in cmdPull
// ---------------------------------------------------------------------------

/**
 * Tests for the wedge-state preflight in `cmdPull`. A wedged REPO_HOME must
 * cause `cmdPull` to die with an actionable message BEFORE any backup dir is
 * created and BEFORE git pull runs. A clean repo must proceed normally.
 *
 * Uses `vi.doMock` on the wedge module so the test controls detectWedge
 * without needing a real `.git/` repo scaffold, keeping the test focused on
 * the preflight behavior rather than the detector (covered by wedge.test.ts).
 */
describe('cmdPull wedge preflight', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-wedge-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    // Scaffold a minimal valid repo so REPO_HOME and settings.base.json
    // preconditions both pass (required before the wedge check fires).
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
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
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./utils.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('dies with actionable message and sets exitCode=1 on a mid-rebase repo (before backup dir)', async () => {
    // Point BACKUP_BASE into our temp HOME so we can assert no backup dir exists.
    const backupBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => 'rebase') };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(process.exitCode).toBe(1);
    // No backup dir created before the wedge check fires.
    expect(existsSync(backupBase)).toBe(false);
  });

  it('emits a message naming the mid-rebase state and pointing at --force-remote', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => 'rebase') };
    });
    // fail() routes through console.error; capture it here.
    const errorLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.join(' '));
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    const combined = errorLines.join('\n');
    expect(combined).toMatch(/mid-rebase/);
    expect(combined).toMatch(/--force-remote/);
    expect(combined).toMatch(/FAQ/);
  });

  it('emits a message naming the mid-merge state on a mid-merge repo', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => 'merge') };
    });
    const errorLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.join(' '));
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    const combined = errorLines.join('\n');
    expect(combined).toMatch(/mid-merge/);
    expect(combined).toMatch(/--force-remote/);
  });

  it('does NOT call git pull when the repo is wedged', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => 'rebase') };
    });
    const gitOrFatalSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: gitOrFatalSpy };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(gitOrFatalSpy).not.toHaveBeenCalled();
  });

  it('proceeds normally (no die) on a clean repo', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => null) };
    });
    // Mock gitOrFatal so git pull does not actually run (no real repo).
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cmdPull forceRemote routing
// ---------------------------------------------------------------------------

/**
 * Helpers for the forceRemote routing tests. These use real git repos so that
 * both detectWedge and recoverForceRemote run against the actual filesystem
 * state, exercising the full integration path.
 */

/** Run a git command with explicit cwd; throws on non-zero. */
function g(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Capture stdout of a git command; throws on non-zero. */
function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/**
 * Build a real bare-origin + local clone that is left wedged mid-rebase (both
 * local and remote changed the same file), plus a `shared/settings.base.json`
 * scaffold so the cmdPull preconditions pass.
 *
 * Sets `process.env.NOMAD_REPO` to `local` so that cmdPull's REPO_HOME
 * resolves to the wedged repo.
 *
 * @param tmp   Parent temp directory.
 * @param file  File to conflict on (default: `tool.ts`; must not be synced config).
 */
function buildWedgedRepo(tmp: string, file = 'tool.ts'): { local: string; origin: string } {
  const origin = join(tmp, 'origin.git');
  const local = join(tmp, 'local');
  mkdirSync(origin, { recursive: true });

  // Init bare origin with base commit.
  g(['init', '-q', '-b', 'main', '--bare'], origin);
  const seed = join(tmp, 'seed');
  mkdirSync(seed, { recursive: true });
  g(['init', '-q', '-b', 'main'], seed);
  g(['config', 'user.email', 'test@example.invalid'], seed);
  g(['config', 'user.name', 'test'], seed);
  // Scaffold shared/settings.base.json so cmdPull preconditions pass.
  mkdirSync(join(seed, 'shared'), { recursive: true });
  writeFileSync(join(seed, 'shared', 'settings.base.json'), '{}\n');
  writeFileSync(join(seed, file), 'v1\n');
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'base'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  // Clone local.
  g(['clone', '-q', origin, local], tmp);
  g(['config', 'user.email', 'test@example.invalid'], local);
  g(['config', 'user.name', 'test'], local);

  // Advance origin.
  const other = join(tmp, 'other');
  g(['clone', '-q', origin, other], tmp);
  g(['config', 'user.email', 'test@example.invalid'], other);
  g(['config', 'user.name', 'test'], other);
  writeFileSync(join(other, file), 'remote\n');
  g(['add', file], other);
  g(['commit', '-q', '-m', 'remote commit'], other);
  g(['push', '-q', 'origin', 'main'], other);

  // Local adds a conflicting change.
  writeFileSync(join(local, file), 'local\n');
  g(['add', file], local);
  g(['commit', '-q', '-m', 'local commit'], local);

  // Fetch + rebase to wedge.
  g(['fetch', '-q', 'origin'], local);
  try {
    execFileSync('git', ['rebase', 'origin/main'], {
      cwd: local,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* expected conflict; repo is now wedged */
  }

  return { local, origin };
}

describe('cmdPull forceRemote routing', () => {
  let tmp: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-force-'));
    process.env.NOMAD_HOST = 'test-host';
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
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('forceRemote: true on wedged repo recovers (HEAD at origin/main, parking branch exists)', async () => {
    const { local } = buildWedgedRepo(tmp);
    process.env.NOMAD_REPO = local;
    // Do NOT mock utils.ts/gitOrFatal here: recoverForceRemote needs to run
    // real git ops (abort, fetch, branch, reset). After recovery, the repo is
    // at origin/main and git pull --rebase is a no-op (already up to date).
    // Only mock the sync side-effects that would touch ~/.claude/.
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    // Run recovery: no throw expected (recovery succeeds; post-recovery pull
    // is a no-op since HEAD is already at origin/main after reset).
    cmdPull({ forceRemote: true });
    expect(process.exitCode).not.toBe(1);

    // Recovery ran: HEAD at origin/main and a nomad/stranded-* branch exists.
    const head = gitOut(['rev-parse', 'HEAD'], local);
    const originMain = gitOut(['rev-parse', 'origin/main'], local);
    expect(head).toBe(originMain);

    const branches = gitOut(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim().length).toBeGreaterThan(0);
    vi.doUnmock('./links.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });

  it('forceRemote: false on wedged repo still refuses (exitCode 1, no recovery)', async () => {
    const { local } = buildWedgedRepo(tmp);
    process.env.NOMAD_REPO = local;
    const headBefore = gitOut(['rev-parse', 'HEAD'], local);
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: false });
    expect(process.exitCode).toBe(1);

    // No recovery: HEAD unchanged, no parking branch.
    const headAfter = gitOut(['rev-parse', 'HEAD'], local);
    expect(headAfter).toBe(headBefore);
    const branches = gitOut(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim()).toBe('');
  });

  it('clean repo: forceRemote is ignored (no recovery attempted)', async () => {
    // Use a mocked detectWedge returning null to confirm the recovery path is skipped.
    const testHome = join(tmp, 'home');
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    const repoHome = join(testHome, 'claude-nomad');
    mkdirSync(join(repoHome, 'shared'), { recursive: true });
    writeFileSync(join(repoHome, 'shared', 'settings.base.json'), '{}\n');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, detectWedge: vi.fn(() => null) };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull({ forceRemote: true })).not.toThrow();
    expect(process.exitCode).toBe(0);
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });
});

// ---------------------------------------------------------------------------
// cmdPull end-to-end: pre/post-rebase HEAD capture and .planning overlay
// ---------------------------------------------------------------------------

/**
 * Build a bare-origin + local-clone repo pair with a committed .planning
 * extras file so cmdPull can exercise the full git pull --rebase + HEAD
 * capture + remapExtrasPull chain.
 *
 * Scaffolds shared/settings.base.json so cmdPull preconditions pass.
 * Sets NOMAD_REPO to `local` and HOME to `tmp` so no real filesystem is
 * mutated.
 *
 * @param tmp Parent temp directory.
 * @returns Paths: local (repo), origin, projectRoot (host project dir).
 */
function buildSyncedRepo(tmp: string): {
  local: string;
  origin: string;
  projectRoot: string;
} {
  const origin = join(tmp, 'origin.git');
  const local = join(tmp, 'local');
  const projectRoot = join(tmp, 'project');
  mkdirSync(origin, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  g(['init', '-q', '-b', 'main', '--bare'], origin);
  const seed = join(tmp, 'seed');
  mkdirSync(seed, { recursive: true });
  g(['init', '-q', '-b', 'main'], seed);
  g(['config', 'user.email', 'test@example.invalid'], seed);
  g(['config', 'user.name', 'test'], seed);
  mkdirSync(join(seed, 'shared'), { recursive: true });
  writeFileSync(join(seed, 'shared', 'settings.base.json'), '{}\n');
  writeFileSync(
    join(seed, 'path-map.json'),
    JSON.stringify({
      projects: { testproj: { 'test-host': projectRoot } },
      extras: { testproj: ['.planning'] },
    }) + '\n',
  );
  mkdirSync(join(seed, 'shared', 'extras', 'testproj', '.planning'), { recursive: true });
  writeFileSync(join(seed, 'shared', 'extras', 'testproj', '.planning', 'PLAN.md'), '# plan\n');
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'base'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  g(['clone', '-q', origin, local], tmp);
  g(['config', 'user.email', 'test@example.invalid'], local);
  g(['config', 'user.name', 'test'], local);

  return { local, origin, projectRoot };
}

describe('cmdPull end-to-end: HEAD capture and .planning overlay (TDD acceptance)', () => {
  let tmp: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-heads-'));
    process.env.NOMAD_HOST = 'test-host';
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
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('cmdPull propagates upstream-deleted .planning file to localRoot (end-to-end)', async () => {
    const { local, origin, projectRoot } = buildSyncedRepo(tmp);
    process.env.HOME = tmp;
    process.env.NOMAD_REPO = local;

    // Push a DELETE-ME.md to origin (so local can fetch it), then remove it.
    const other = join(tmp, 'other');
    g(['clone', '-q', origin, other], tmp);
    g(['config', 'user.email', 'test@example.invalid'], other);
    g(['config', 'user.name', 'test'], other);
    mkdirSync(join(other, 'shared', 'extras', 'testproj', '.planning'), { recursive: true });
    writeFileSync(
      join(other, 'shared', 'extras', 'testproj', '.planning', 'DELETE-ME.md'),
      'will be deleted\n',
    );
    g(['add', '.'], other);
    g(['commit', '-q', '-m', 'add DELETE-ME.md'], other);
    g(['push', '-q', 'origin', 'main'], other);

    // Local must pull the addition first (so pre HEAD is after it was added).
    g(['pull', '--rebase', '-q'], local);

    // Now push the deletion from other.
    g(['rm', '-q', join('shared', 'extras', 'testproj', '.planning', 'DELETE-ME.md')], other);
    g(['commit', '-q', '-m', 'delete DELETE-ME.md'], other);
    g(['push', '-q', 'origin', 'main'], other);

    // Seed local .planning with the file (simulating the host state before pull).
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'will be deleted\n');

    // Mock only the ~/.claude-touching side effects; let git ops run real.
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));

    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(process.exitCode).not.toBe(1);

    // End-to-end: upstream-deleted file removed from localRoot.
    expect(existsSync(join(projectRoot, '.planning', 'DELETE-ME.md'))).toBe(false);
    // Non-deleted file survives.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('cmdPull preserves local-only .planning file (overlay semantics end-to-end)', async () => {
    const { local, projectRoot } = buildSyncedRepo(tmp);
    process.env.HOME = tmp;
    process.env.NOMAD_REPO = local;

    // Seed a local-only file not tracked by the repo.
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'local-only.md'), 'my work\n');

    mkdirSync(join(tmp, '.claude'), { recursive: true });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));

    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(process.exitCode).not.toBe(1);

    // Local-only file survives (overlay does not delete it).
    expect(existsSync(join(projectRoot, '.planning', 'local-only.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.planning', 'local-only.md'), 'utf8')).toBe('my work\n');
  });

  it('fresh-clone-style (unborn HEAD): cmdPull completes without throw and deletes nothing', async () => {
    // Simulate: NOMAD_REPO does not have commits yet (unborn HEAD). captureHead
    // returns undefined -> capturePrePostHeads returns undefined -> overlay only.
    // We use a mocked gitOrFatal and a mocked gitCaptureRaw that throws on
    // rev-parse (simulating unborn HEAD) to exercise the undefined branch.
    const testHome = join(tmp, 'home');
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    const repoDir = join(testHome, 'claude-nomad');
    mkdirSync(join(repoDir, 'shared'), { recursive: true });
    writeFileSync(join(repoDir, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(join(testHome, '.claude'), { recursive: true });

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // rev-parse fails (unborn HEAD); gitOrFatal is the pull itself.
        gitCaptureRaw: vi.fn(() => {
          throw new Error('fatal: ambiguous argument HEAD');
        }),
        gitOrFatal: vi.fn(),
      };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));

    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).not.toBe(1);

    // remapExtrasPull was called with undefined prePostHeads (no delete pass).
    const { remapExtrasPull } = await import('./extras-sync.ts');
    const calls = (remapExtrasPull as ReturnType<typeof vi.fn>).mock.calls;
    // opts.prePostHeads must be absent (no second arg or opts without prePostHeads).
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[0]?.[1] as { prePostHeads?: unknown } | undefined;
    expect(opts?.prePostHeads).toBeUndefined();
  });
});
