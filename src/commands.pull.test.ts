import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as wedgeModule from './commands.pull.wedge.ts';
import type * as recoveryModule from './commands.pull.recovery.ts';
import type * as recoveryUnmergedModule from './commands.pull.recovery.unmerged.ts';

import type * as baselineModule from './links.baseline.ts';
import type * as linksModule from './links.ts';
import type * as linksMirrorModule from './links.mirror.ts';
import type * as utilsModule from './utils.ts';
import type * as lockfileModule from './utils.lockfile.ts';

import { warnGlyph } from './color.ts';
import { plantSharedBaseline } from './test-support/baseline.ts';
import { stubPlatform } from './test-helpers.platform.ts';

/**
 * Partially mock `links.mirror.ts`, keeping every real export and replacing
 * only `stageLocalSharedEdits`.
 *
 * Spreading the real module matters rather than replacing it outright: the
 * win32 denylist backstop (revertDeniedUnderShared) reaches
 * revertDeniedMirrorPaths outside reconcileSharedLinksBeforePull's try/catch,
 * and a bare `{ stageLocalSharedEdits }` factory leaves that export undefined
 * there.
 *
 * @param impl - The replacement spy. Defaults to a fresh `vi.fn()`.
 * @returns The spy installed as `stageLocalSharedEdits`.
 */
function mockMirrorModule(impl: ReturnType<typeof vi.fn> = vi.fn()): ReturnType<typeof vi.fn> {
  vi.doMock('./links.mirror.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof linksMirrorModule>();
    return { ...actual, stageLocalSharedEdits: impl };
  });
  return impl;
}

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
    // process.exitCode is process-global. A timed-out test's detached work can
    // set it AFTER its own afterEach reset has run, so clear it on entry too or
    // one flake fails the next test on state it never created.
    process.exitCode = 0;
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
    process.exitCode = 0;
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
    // classifyWedge calls unmergedIndexPresent (execFileSync git diff) which
    // fails on a non-git temp dir. Mock it to return null (clean repo) so the
    // extras integration tests focus on their own scope.
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
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
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.baseline.ts');
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    expect(remapExtrasPullMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prePostHeads: undefined }),
    );
  });

  it('dry-run skips remapExtrasPull but still runs divergenceCheckExtras (read-only contract)', async () => {
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    // Additive contract: the call sites in cmdPull always fire; the
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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

  it('surfaces extrasResult.skipped in the WET-pull Pull summary row of the grouped tree', async () => {
    // skipped=3 from remapExtrasPull surfaces in the in-tree Pull summary row
    // as "3 extras skipped". On the WET path the summary renders through the
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    expect(combined).toContain('Pull summary');
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    expect(out).toContain('Pull summary');
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    process.exitCode = 0;
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
    vi.doUnmock('./commands.pull.recovery.ts');
    vi.doUnmock('./commands.pull.recovery.unmerged.ts');
    vi.doUnmock('./utils.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('dies with actionable message and sets exitCode=4 (CONFLICT) on a mid-rebase repo (before backup dir)', async () => {
    // Point BACKUP_BASE into our temp HOME so we can assert no backup dir exists.
    const backupBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'rebase') };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(process.exitCode).toBe(4);
    // No backup dir created before the wedge check fires.
    expect(existsSync(backupBase)).toBe(false);
  });

  it('emits a message naming the mid-rebase state and pointing at --force-remote', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'rebase') };
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
      return { ...actual, classifyWedge: vi.fn(() => 'merge') };
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
      return { ...actual, classifyWedge: vi.fn(() => 'rebase') };
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
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
  const realPlatform = process.platform;
  let tmp: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    process.exitCode = 0;
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
    stubPlatform(realPlatform);
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });

  it('forceRemote: true on a REAL win32 rebase wedge skips the mirror (genuine discard, not a flag check)', async () => {
    stubPlatform('win32');
    const { local } = buildWedgedRepo(tmp);
    process.env.NOMAD_REPO = local;
    // Do NOT mock utils.ts/gitOrFatal here: recoverForceRemote needs to run
    // real git ops (abort, fetch, branch, reset).
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    const mirrorSpy = mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: true });
    expect(process.exitCode).not.toBe(1);

    // Recovery genuinely ran: the reset --hard origin/main discard is what
    // makes skipping the WET mirror correct here, so pin both signals in one
    // test rather than trusting the mirror-skip assertion alone (a run that
    // never actually recovered would also leave the mirror uncalled, and
    // that would be the exact regression this test exists to catch).
    const head = gitOut(['rev-parse', 'HEAD'], local);
    const originMain = gitOut(['rev-parse', 'origin/main'], local);
    expect(head).toBe(originMain);
    const branches = gitOut(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim().length).toBeGreaterThan(0);

    // The WET reconcile step (reconcileSharedLinksBeforePull) never ran. The
    // one call the mirror spy did see is describeSkippedMirrorDiscard's own
    // read-only tally of what that skip is about to cost (D-02), which is
    // always dryRun: true; asserting on the flag rather than a zero call
    // count is what keeps this test from regressing every time the D-02
    // warning computes its own tally.
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    const mirrorCall = mirrorSpy.mock.calls[0] as [unknown, unknown, { dryRun?: unknown }];
    expect(mirrorCall[2]?.dryRun).toBe(true);
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });

  it('forceRemote: false on wedged repo still refuses (exitCode 4 CONFLICT, no recovery)', async () => {
    const { local } = buildWedgedRepo(tmp);
    process.env.NOMAD_REPO = local;
    const headBefore = gitOut(['rev-parse', 'HEAD'], local);
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: false });
    expect(process.exitCode).toBe(4);

    // No recovery: HEAD unchanged, no parking branch.
    const headAfter = gitOut(['rev-parse', 'HEAD'], local);
    expect(headAfter).toBe(headBefore);
    const branches = gitOut(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim()).toBe('');
  });

  it('clean repo: forceRemote is ignored (no recovery attempted)', async () => {
    // Use a mocked classifyWedge returning null to confirm the recovery path is skipped.
    const testHome = join(tmp, 'home');
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    const repoHome = join(testHome, 'claude-nomad');
    mkdirSync(join(repoHome, 'shared'), { recursive: true });
    writeFileSync(join(repoHome, 'shared', 'settings.base.json'), '{}\n');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull({ forceRemote: true })).not.toThrow();
    expect(process.exitCode).toBe(0);
    // D-04: a clean repo under --force-remote is not a silent no-op; it
    // reports that there was nothing to recover before proceeding.
    const combined = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('nothing to recover');
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.baseline.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });
});

// ---------------------------------------------------------------------------
// handleWedge unmerged-index dispatch (classifyWedge integration)
// ---------------------------------------------------------------------------

/**
 * Tests for the new unmerged-index dispatch in handleWedge. These mock
 * classifyWedge (the new combinator) and recoverUnmergedIndex so no real git
 * repo is needed; behavior under forceRemote=true/false is isolated cleanly.
 */
describe('handleWedge unmerged-index dispatch', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-index-wedge-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
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
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./commands.pull.recovery.ts');
    vi.doUnmock('./commands.pull.recovery.unmerged.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('default path (forceRemote=false) dies with the runbook and does NOT mutate the index', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'unmerged-index') };
    });
    const errorLines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.join(' '));
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: false });
    expect(process.exitCode).toBe(4);
    const combined = errorLines.join('\n');
    // Runbook must name the manual recovery steps.
    expect(combined).toMatch(/git reset --mixed HEAD/);
    expect(combined).toMatch(/git stash list/);
    expect(combined).toMatch(/nomad pull --force-remote/);
    expect(combined).toMatch(/FAQ/);
  });

  it('default path does NOT call recoverUnmergedIndex (non-destructive default)', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'unmerged-index') };
    });
    const recoverUnmergedIndexSpy = vi.fn();
    vi.doMock('./commands.pull.recovery.unmerged.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryUnmergedModule>();
      return { ...actual, recoverUnmergedIndex: recoverUnmergedIndexSpy };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: false });
    expect(recoverUnmergedIndexSpy).not.toHaveBeenCalled();
  });

  it('forceRemote=true calls recoverUnmergedIndex and NOT recoverForceRemote', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'unmerged-index') };
    });
    const recoverUnmergedIndexSpy = vi.fn();
    const recoverForceRemoteSpy = vi.fn();
    vi.doMock('./commands.pull.recovery.unmerged.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryUnmergedModule>();
      return { ...actual, recoverUnmergedIndex: recoverUnmergedIndexSpy };
    });
    vi.doMock('./commands.pull.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, recoverForceRemote: recoverForceRemoteSpy };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: true });
    expect(recoverUnmergedIndexSpy).toHaveBeenCalledWith(repoUnderHome);
    expect(recoverForceRemoteSpy).not.toHaveBeenCalled();
  });

  it('mirrors after an unmerged-index recovery on win32 (reset --mixed preserves the working tree, nothing was discarded)', async () => {
    stubPlatform('win32');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'unmerged-index') };
    });
    vi.doMock('./commands.pull.recovery.unmerged.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryUnmergedModule>();
      return { ...actual, recoverUnmergedIndex: vi.fn() };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    const mirrorSpy = mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: true });
    // This is the test that fails if a future change rewires `recovered` to
    // forceRemote truthiness instead of scoping it to recoverForceRemote: an
    // unmerged-index recovery never discards win32 shared-config content, so
    // the mirror must still run.
    expect(mirrorSpy).toHaveBeenCalled();
  });

  it('forceRemote=true on a rebase-marker state routes to recoverForceRemote, NOT recoverUnmergedIndex', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return { ...actual, classifyWedge: vi.fn(() => 'rebase') };
    });
    const recoverUnmergedIndexSpy = vi.fn();
    const recoverForceRemoteSpy = vi.fn();
    vi.doMock('./commands.pull.recovery.unmerged.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryUnmergedModule>();
      return { ...actual, recoverUnmergedIndex: recoverUnmergedIndexSpy };
    });
    vi.doMock('./commands.pull.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, recoverForceRemote: recoverForceRemoteSpy };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ forceRemote: true });
    expect(recoverForceRemoteSpy).toHaveBeenCalledWith('rebase', repoUnderHome);
    expect(recoverUnmergedIndexSpy).not.toHaveBeenCalled();
  });

  it('classifyWedge returning null is a no-op (no die, no recovery)', async () => {
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    process.exitCode = 0;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-cmdpull-heads-'));
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
    // Some tests in this suite use non-git directories where classifyWedge's
    // execFileSync probe would fail. Mock classifyWedge to return null (clean)
    // so those tests are unaffected. Tests that use real git repos (buildSyncedRepo)
    // are always clean and would return null anyway.
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.baseline.ts');
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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

  it('cmdPull: skills e2e -- user skill overlaid, local gsd-* survives on WET pull', async () => {
    // End-to-end: syncSkillsPull is called on the WET path. A user skill
    // present in shared/skills is overlaid into ~/.claude/skills, and a
    // pre-existing local gsd-* skill is preserved (not deleted).
    const testHome2 = join(tmp, 'home2');
    process.env.HOME = testHome2;
    delete process.env.NOMAD_REPO;
    const repoDir2 = join(testHome2, 'claude-nomad');
    const claudeDir2 = join(testHome2, '.claude');
    const sharedSkills = join(repoDir2, 'shared', 'skills');
    const localSkills = join(claudeDir2, 'skills');
    mkdirSync(join(repoDir2, 'shared'), { recursive: true });
    writeFileSync(join(repoDir2, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(claudeDir2, { recursive: true });
    // Scaffold shared/skills with a user skill (not gsd-prefixed).
    mkdirSync(sharedSkills, { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify'), '# graphify\n');
    // Scaffold ~/.claude/skills as a real dir with a local gsd-* skill already there.
    mkdirSync(localSkills, { recursive: true });
    writeFileSync(join(localSkills, 'gsd-executor'), '# gsd executor\n');

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn(), gitCaptureRaw: vi.fn(() => '') };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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
    expect(process.exitCode).not.toBe(1);

    // User skill overlaid from shared/skills into ~/.claude/skills.
    expect(existsSync(join(localSkills, 'graphify'))).toBe(true);
    expect(readFileSync(join(localSkills, 'graphify'), 'utf8')).toBe('# graphify\n');
    // Local gsd-* skill preserved (not deleted by overlay).
    expect(existsSync(join(localSkills, 'gsd-executor'))).toBe(true);
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });

  it('cmdPull: skills e2e -- dry-run copies nothing into ~/.claude/skills', async () => {
    // Dry-run contract: syncSkillsPull is WET-only; under dryRun computePreview
    // runs and no files are written to ~/.claude/skills.
    const testHome3 = join(tmp, 'home3');
    process.env.HOME = testHome3;
    delete process.env.NOMAD_REPO;
    const repoDir3 = join(testHome3, 'claude-nomad');
    const claudeDir3 = join(testHome3, '.claude');
    const sharedSkills3 = join(repoDir3, 'shared', 'skills');
    const localSkills3 = join(claudeDir3, 'skills');
    mkdirSync(join(repoDir3, 'shared'), { recursive: true });
    writeFileSync(join(repoDir3, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(claudeDir3, { recursive: true });
    mkdirSync(sharedSkills3, { recursive: true });
    writeFileSync(join(sharedSkills3, 'graphify'), '# graphify\n');
    // ~/.claude/skills does not exist yet.
    expect(existsSync(localSkills3)).toBe(false);
    writeFileSync(join(repoDir3, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn(), gitCaptureRaw: vi.fn(() => '') };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./preview.ts', () => ({
      computePreview: vi.fn(() => ({ unmapped: 0 })),
    }));

    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull({ dryRun: true })).not.toThrow();

    // Dry-run: no files written to ~/.claude/skills (zero-mutation contract).
    expect(existsSync(localSkills3)).toBe(false);
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.doUnmock('./preview.ts');
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
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
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

// ---------------------------------------------------------------------------
// runPullCore: lock-free, return-shape contract (new seam for a future
// composing command; see the PLAN's must-haves).
// ---------------------------------------------------------------------------

/**
 * Tests for `runPullCore`'s discriminated return value. `runPullCore` never
 * calls the lockfile primitives itself, so these tests call it directly
 * (without going through `cmdPull`'s acquire/release) and assert no lockfile
 * is ever written, plus that the `dry`/`wet` tags carry the documented shape.
 */
describe('runPullCore: return shape and lock-free contract', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;
  // Shared gitCaptureRaw mock instance: tests override its implementation
  // in place instead of re-registering the ./utils.ts doMock, because a
  // second doMock of a module already wired into an imported graph is racy
  // (the re-import may keep the first factory's instances).
  let gitCaptureRawMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-runpullcore-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      // classifyWedge null = not wedged. probeUnmergedIndex 'clean' keeps the
      // post-pull autostash guard from failing closed on the non-git fixture
      // (the real flow probes a real repo here; this test mocks git pull away).
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    gitCaptureRawMock = vi.fn(() => '');
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn(), gitCaptureRaw: gitCaptureRawMock };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule();
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 2),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: ['proj-a'], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(() => 3),
    }));
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
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.baseline.ts');
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

  it('returns { tag: "wet", sections, localOnly, divergedKeptLocal, incomingChanges } without acquiring the lock', async () => {
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    if (result.tag !== 'wet') throw new Error('unreachable');
    expect(Array.isArray(result.sections)).toBe(true);
    expect(result.sections.length).toBeGreaterThan(0);
    // localOnly comes straight from the mocked scanLocalOnly() return value.
    expect(result.localOnly).toBe(2);
    // divergedKeptLocal comes straight from the mocked divergenceCheckExtras()
    // return value (the both-sides-modified count).
    expect(result.divergedKeptLocal).toBe(3);
    // gitCaptureRaw always returns '' in this suite's default mock, so both
    // the pre- and post-rebase HEAD captures are equal ('' === ''):
    // incomingChanges must be false.
    expect(result.incomingChanges).toBe(false);
    // runPullCore never calls acquireLock: no lockfile is written.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('renders no Symlinks group when the mirror produced no events (posix / mocked-mirror parity)', async () => {
    // The mocked stageLocalSharedEdits never calls onPreview, so
    // reconcileSharedLinksBeforePull's events array stays empty regardless of
    // the runner's real platform. runPullCore always splices a Symlinks
    // section into the returned array (buildMirrorSection(events), even when
    // events is empty), but renderTree drops any section with zero items at
    // render time; this asserts what actually reaches the terminal, which is
    // the guard against the head-of-array splice leaking an empty group into
    // every posix user's output. Extras does not render either in this
    // fixture: the mocked remapExtrasPull returns nothing pulled, which is
    // unrelated to the mirror and just this fixture's own empty data.
    const { runPullCore } = await import('./commands.pull.ts');
    const { renderTree } = await import('./output-tree.ts');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    if (result.tag !== 'wet') throw new Error('unreachable');
    renderTree(result.sections);
    const renderedHeaders = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) =>
        ['Settings', 'Sessions', 'Extras', 'Pull summary', 'Symlinks'].includes(line),
      );
    expect(renderedHeaders).not.toContain('Symlinks');
    expect(renderedHeaders).toEqual(['Settings', 'Sessions', 'Pull summary']);
  });

  it('reports incomingChanges: true when the pre-rebase HEAD cannot be captured (fresh clone)', async () => {
    gitCaptureRawMock.mockImplementation(() => {
      throw new Error('fatal: ambiguous argument HEAD');
    });
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    if (result.tag !== 'wet') throw new Error('unreachable');
    expect(result.incomingChanges).toBe(true);
  });

  it('reports incomingChanges: true when the rebase moves REPO_HOME HEAD (pre !== post)', async () => {
    gitCaptureRawMock.mockReturnValueOnce('sha-before').mockReturnValueOnce('sha-after');
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    if (result.tag !== 'wet') throw new Error('unreachable');
    expect(result.incomingChanges).toBe(true);
  });

  it('reports incomingChanges: false when the rebase leaves REPO_HOME HEAD unchanged (pre === post)', async () => {
    gitCaptureRawMock.mockReturnValue('sha-same');
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    if (result.tag !== 'wet') throw new Error('unreachable');
    expect(result.incomingChanges).toBe(false);
  });

  it('suppresses the pull-on-host header under compose: true (composing caller owns the header)', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore({ compose: true });
    expect(result.tag).toBe('wet');
    const combined = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(combined).not.toContain('pull on host=');
  });

  it('prints the pull-on-host header when compose is not set (standalone output unchanged)', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    expect(result.tag).toBe('wet');
    const combined = logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(combined).toContain('pull on host=');
  });

  it('returns { tag: "dry" } on --dry-run and renders its own preview inline', async () => {
    vi.doMock('./preview.ts', () => ({
      computePreview: vi.fn(() => ({ unmapped: 0 })),
    }));
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore({ dryRun: true });
    expect(result).toEqual({ tag: 'dry' });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('dies fatally when the backup root cannot be created (fail-fast before any mutation)', async () => {
    // Plant a regular FILE where the backup root directory should live, so
    // mkdirSync(join(backup, ts), { recursive: true }) throws ENOTDIR. The
    // wet path must convert that into a fatal die() BEFORE any mutation.
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(join(testHome, '.cache', 'claude-nomad', 'backup'), 'not a dir\n');
    const { runPullCore } = await import('./commands.pull.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => runPullCore()).toThrow(NomadFatal);
    expect(() => runPullCore()).toThrow(/could not create backup dir/);
    // Fatal fired before acquireLock could ever be reached (core is lock-free).
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPullCore: win32 pre-pull shared-link mirror
// ---------------------------------------------------------------------------

// On posix a shared name is a symlink, so an edit to ~/.claude/CLAUDE.md is
// already an uncommitted change in the sync repo when a pull starts and the
// autostash carries it through the rebase. On win32 it is a real copy that
// applySharedLinksWin32 would overwrite from the repo, so the mirror has to run
// BEFORE `git pull --rebase` for the same edit to survive.
describe('runPullCore: win32 pre-pull shared-link mirror', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-pull-mirror-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO and only falls back to $HOME/claude-nomad,
    // and CLAUDE.md tells developers to export it for an alternate checkout, so
    // an ambient value would point these assertions at a repo the code under
    // test never touched.
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./commands.pull.recovery.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.baseline.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.doUnmock('./preview.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Mock the pull pipeline, recording the mirror, the `git pull --rebase`, the
   * shared-link apply, and the baseline write into one shared ordering log.
   *
   * The baseline write has to be asserted by call order rather than by effect:
   * on a fixture where the apply changes nothing, a before-apply and an
   * after-apply write produce identical files, and before-apply is exactly the
   * ordering that would let an aborted pull record files the host never received.
   *
   * Both seams a caller might want to drive are parameters rather than a second
   * `vi.doMock` at the call site. Registering the same specifier twice does not
   * reliably override the first factory, so a caller that re-mocked `preview.ts`
   * or `utils.ts` here silently kept THIS one and asserted against a spy nothing
   * ever called.
   *
   * @param order - Array appended to on each mocked call.
   * @param opts.previewSpy - Stands in for `computePreview`, for argument assertions.
   * @param opts.onGitOrFatal - Extra side effect for the mocked `git pull --rebase`,
   *   e.g. deleting a repo file to simulate an upstream deletion arriving with the rebase.
   * @returns The `stageLocalSharedEdits` spy, for argument assertions.
   */
  function mockPipelineRecording(
    order: string[],
    opts: { previewSpy?: ReturnType<typeof vi.fn>; onGitOrFatal?: () => void } = {},
  ): ReturnType<typeof vi.fn> {
    const mirrorSpy = vi.fn(() => {
      order.push('mirror');
    });
    vi.doMock('./links.baseline.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof baselineModule>();
      return {
        ...actual,
        writeSharedBaseline: vi.fn(() => {
          order.push('baseline');
        }),
      };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(() => {
        order.push('apply');
      }),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    mockMirrorModule(mirrorSpy);
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(() => 0),
    }));
    vi.doMock('./preview.ts', () => ({ computePreview: opts.previewSpy ?? vi.fn() }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: vi.fn(() => {
          order.push('gitOrFatal');
          opts.onGitOrFatal?.();
        }),
      };
    });
    return mirrorSpy;
  }

  /**
   * Assert the mirror spy's first call matches `(map, <backup timestamp>, { onPreview: <fn> })`.
   * Written as positional-argument checks rather than
   * `toHaveBeenCalledWith(..., expect.objectContaining(...))` so the untyped
   * `vi.fn()` spy's `any`-typed call args never flow through a nested
   * `expect.any()` matcher, which trips `no-unsafe-assignment`.
   *
   * @param mirror - The mirror spy returned by `mockPipelineRecording`.
   * @param map - Expected first argument (the path map passed through).
   */
  function expectMirrorCalledWith(mirror: ReturnType<typeof vi.fn>, map: unknown): void {
    const call = mirror.mock.calls[0] as [unknown, unknown, { onPreview?: unknown } | undefined];
    expect(call[0]).toEqual(map);
    expect(typeof call[1]).toBe('string');
    expect(typeof call[2]?.onPreview).toBe('function');
  }

  it('mirrors the host-side copies into the repo BEFORE git pull --rebase on win32', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
    expect(order).toEqual(['mirror', 'gitOrFatal', 'apply', 'baseline']);
    // The backup timestamp is threaded through so the mirror can snapshot the
    // repo-side copy it is about to overwrite.
    expectMirrorCalledWith(mirrorSpy, { projects: {} });
  });

  it('does not mirror on a posix platform, where the symlink already made the edit live', async () => {
    stubPlatform('linux');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
    expect(order).toEqual(['gitOrFatal', 'apply', 'baseline']);
    expect(mirrorSpy).not.toHaveBeenCalled();
  });

  it('runs the mirror in dryRun mode only under dryRun on win32 (zero-mutation preview contract)', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ dryRun: true });
    // The mirror now runs under dry-run too, via planSharedReconcileBeforePull
    // computing the pre-rebase capture plan the preview renders, but it is
    // always called with dryRun: true, so no disk mutation occurs. The
    // WET-only reconcile (reconcileSharedLinksBeforePull) does not run, so the
    // mirror is called exactly once here rather than the twice a wet pull on
    // win32 would produce.
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    const call = mirrorSpy.mock.calls[0] as [
      unknown,
      unknown,
      { dryRun?: unknown; onPreview?: unknown } | undefined,
    ];
    expect(call[2]?.dryRun).toBe(true);
    expect(typeof call[2]?.onPreview).toBe('function');
    // The baseline write and the shared-link apply both live on the wet-only
    // path, so a dry run is excluded structurally rather than by a flag anyone
    // can later get wrong.
    expect(order).not.toContain('apply');
    expect(order).not.toContain('baseline');
  });

  it('computes the win32 dry-run plans before the rebase, not after it', async () => {
    stubPlatform('win32');
    mkdirSync(join(testHome, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(repoUnderHome, 'shared', 'commands'), { recursive: true });
    const gone = join(repoUnderHome, 'shared', 'commands', 'gone.md');
    writeFileSync(gone, '# gone\n');
    const cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'shared-baseline-test-host.json'),
      JSON.stringify({
        schema: 1,
        scannerVersion: 'shared-links-baseline/1',
        configHash: 'not-applicable',
        files: { 'commands/gone.md': { size: 1, mtime: 1, hash: 'x' } },
      }) + '\n',
    );

    const order: string[] = [];
    const previewSpy = vi.fn();
    mockPipelineRecording(order, {
      previewSpy,
      // The rebase brings an upstream deletion of the same file, which is the
      // window where a plan computed afterwards silently disagrees with what
      // a wet run of the same moment would have done.
      onGitOrFatal: () => {
        rmSync(gone, { force: true });
      },
    });

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ dryRun: true });

    const plans = previewSpy.mock.calls[0]?.[3] as
      { deletions: { repoPath: string }[] } | undefined;
    expect(plans?.deletions.map((d) => d.repoPath)).toEqual([gone]);
  });

  it('writes the baseline after the shared-link apply, never before it', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
    // Recording BEFORE the apply would let a run that died mid-pull record files
    // the host never actually received, and authorize deleting them next run.
    expect(order.indexOf('baseline')).toBeGreaterThan(order.indexOf('apply'));
    expect(order.indexOf('baseline')).toBeGreaterThan(order.indexOf('gitOrFatal'));
  });

  it('mirrors on a clean repo even under forceRemote (nothing to recover)', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ forceRemote: true });
    expect(mirrorSpy).toHaveBeenCalled();
  });

  it('emits the clean-repo info line under forceRemote with no platform stub (D-05: platform-agnostic)', async () => {
    // No stubPlatform call anywhere in this test: the absence is the
    // assertion. handleWedge has no win32 branch, so the clean-repo info
    // line must fire identically on whatever real platform this test runs
    // on, not just when win32 is stubbed in.
    const order: string[] = [];
    mockPipelineRecording(order);
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ forceRemote: true });
    const combined = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('nothing to recover');
  });

  it('does not emit the clean-repo info line on a plain pull (no forceRemote)', async () => {
    const order: string[] = [];
    mockPipelineRecording(order);
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
    const combined = logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).not.toContain('nothing to recover');
  });

  it('warns and still pulls when the staging copy throws on win32', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    mirrorSpy.mockImplementation(() => {
      order.push('mirror');
      throw new Error('EPERM: operation not permitted');
    });
    const { runPullCore } = await import('./commands.pull.ts');
    // The copy can throw for reasons unrelated to intent (Windows path limit,
    // antivirus lock, EPERM on a read-only repo file). Aborting here would
    // leave the host unable to fetch at all, so the pre-step contains it.
    expect(() => runPullCore()).not.toThrow();
    expect(order, 'the pull did not continue past the failed mirror').toEqual([
      'mirror',
      'gitOrFatal',
      'apply',
      'baseline',
    ]);
  });

  it('still stages with the empty map when path-map.json is absent on win32', async () => {
    stubPlatform('win32');
    rmSync(join(repoUnderHome, 'path-map.json'), { force: true });
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
    // Absent is a valid steady state (a clone that predates init), and
    // allSharedLinks({projects:{}}) is exactly SHARED_LINKS, so the mirror must
    // still run: skipping it here would silently disable the fix in the very
    // case it exists to cover.
    expectMirrorCalledWith(mirrorSpy, { projects: {} });
    expect(order).toEqual(['mirror', 'gitOrFatal', 'apply', 'baseline']);
  });

  it('passes null on a malformed path-map.json, leaving the fatal to the pull proper', async () => {
    stubPlatform('win32');
    writeFileSync(join(repoUnderHome, 'path-map.json'), '{ not json\n');
    const order: string[] = [];
    const mirrorSpy = mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    // The mirror degrades to null rather than throwing, so it is never what
    // fails a pull; the post-rebase readPathMap still dies loudly as before.
    // Matched on the message so an unrelated failure (a mis-wired doMock, a
    // missing settings.base.json) cannot masquerade as this assertion passing.
    expect(() => runPullCore()).toThrow(/path-map\.json/);
    expectMirrorCalledWith(mirrorSpy, null);
  });

  it('renders the D-02 discard warning in the wet Symlinks section when recovery genuinely ran', async () => {
    stubPlatform('win32');
    // Override the beforeEach's clean-repo wedge mock: this test needs a
    // genuine wedge so handleWedge's recoverForceRemote arm runs and
    // `recovered` comes back true, which is the only condition that gates
    // describeSkippedMirrorDiscard.
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return {
        ...actual,
        classifyWedge: vi.fn(() => 'rebase'),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.doMock('./commands.pull.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, recoverForceRemote: vi.fn() };
    });
    // A discard-describing mirror spy: unlike mockPipelineRecording's default
    // (which never calls onPreview), this one reports one captured name, so
    // the tally the warning row names is non-zero and checkable. This is the
    // ONLY stageLocalSharedEdits call reachable on this run: the wet
    // reconcile step is skipped because `recovered` is true, and the dry-run
    // plan step is skipped because `dryRun` is false.
    const discardMirrorSpy = vi.fn(
      (_map: unknown, _ts: unknown, opts?: { onPreview?: (e: unknown) => void }) => {
        opts?.onPreview?.({
          kind: 'mirror',
          name: 'CLAUDE.md',
          localPath: join(testHome, '.claude', 'CLAUDE.md'),
          repoPath: join(repoUnderHome, 'shared', 'CLAUDE.md'),
        });
      },
    );
    mockMirrorModule(discardMirrorSpy);
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(),
      regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })),
    }));
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(() => 0),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore({ forceRemote: true });
    if (result.tag !== 'wet') throw new Error('expected a wet pull result');

    const symlinks = result.sections.find((s) => s.header === 'Symlinks');
    const rendered = symlinks?.items.join('\n') ?? '';
    expect(rendered).toContain(warnGlyph);
    expect(rendered).toContain('1 shared name was restored from the repo copy');
    expect(discardMirrorSpy).toHaveBeenCalledTimes(1);
    const call = discardMirrorSpy.mock.calls[0] as [unknown, unknown, { dryRun?: unknown }];
    expect(call[2]?.dryRun).toBe(true);
  });

  it('renders no discard warning in the wet Symlinks section when the mirror was not skipped', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    mockPipelineRecording(order);
    const { runPullCore } = await import('./commands.pull.ts');
    const result = runPullCore();
    if (result.tag !== 'wet') throw new Error('expected a wet pull result');

    const symlinks = result.sections.find((s) => s.header === 'Symlinks');
    const rendered = symlinks?.items.join('\n') ?? '';
    expect(rendered).not.toContain(warnGlyph);
    expect(rendered).not.toContain('restored from the repo copy');
  });
});

// ---------------------------------------------------------------------------
// runPullCore: shared-name derivation across the rebase boundary
// ---------------------------------------------------------------------------

/**
 * The pre-rebase win32 reconcile and the post-rebase shared-link apply act on
 * two DIFFERENT repo states, because the rebase between them can add or remove
 * both a `sharedDirs` entry and its `shared/<name>` content. These tests run
 * the real `applySharedLinks`, `links.mirror.ts`, `links.baseline.ts` and
 * `preview.ts` (only the git call, the session/extras/skills copies and the
 * settings write are mocked) so they assert the observable outcome: what ends
 * up in `~/.claude/`, and how many times one invalid entry is reported.
 */
describe('runPullCore: shared-name derivation across the rebase boundary', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let errSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-pull-names-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    claudeDir = join(testHome, '.claude');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return {
        ...actual,
        classifyWedge: vi.fn(() => null),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.doMock('./remap.ts', () => ({
      scanLocalOnly: vi.fn(() => 0),
      remapPull: vi.fn(() => ({ unmapped: 0, pulled: [], wouldPull: [] })),
      remapPush: vi.fn(),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(() => ({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] })),
      divergenceCheckExtras: vi.fn(() => 0),
    }));
    vi.doMock('./skills-sync.ts', () => ({ syncSkillsPull: vi.fn(), syncSkillsPush: vi.fn() }));
    // Only the settings write is replaced; applySharedLinks stays real because
    // its derivation is what these counts are about. The wet pull regenerates
    // settings.json through the atomic writer, whose last step fsyncs the
    // parent directory, and Windows answers that syscall with EPERM. The
    // product code skips the step when `process.platform === 'win32'`, but a
    // test that stubs the platform to linux to pin posix behavior turns that
    // guard off while the real syscall still runs, so a real Windows host
    // failed the posix case here on a durability step none of these tests
    // assert on.
    vi.doMock('./links.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof linksModule>();
      return { ...actual, regenerateSettings: vi.fn(() => ({ label: 'no host overrides' })) };
    });
    // links.baseline.ts is deliberately NOT mocked here. It carries a
    // shared-name derivation of its own on the wet path (writeSharedBaseline),
    // and stubbing it out is what let an "exactly once" count pass while the
    // real win32 host emitted more. Same reason a baseline manifest is planted:
    // without one the deletion planner returns before enumerating, so a second
    // derivation site never runs and the count is pinned for the wrong reason.
    plantSharedBaseline(testHome);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.doUnmock('./skills-sync.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Mock `git pull --rebase` with an optional side effect standing in for what
   * the fetch delivered, so a test can make the repo change underneath the run
   * exactly where a real rebase would.
   *
   * @param onRebase - Side effect applied when the mocked pull runs.
   */
  function mockRebase(onRebase?: () => void): void {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: vi.fn(() => {
          onRebase?.();
        }),
        gitCaptureRaw: vi.fn(() => 'sha'),
      };
    });
  }

  /** Every captured `sharedDirs` rejection WARN line for the run. */
  function rejectionWarns(): string[] {
    return errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((line) => line.includes('sharedDirs entry'));
  }

  it('materializes a sharedDirs entry that arrived IN this pull, on win32', async () => {
    stubPlatform('win32');
    // The rebase delivers both halves of a new shared dir: the path-map entry
    // that authorizes it and the shared/<name> content itself. A name list
    // derived before the fetch cannot contain it, so the apply would skip the
    // directory and the pull would report success having created nothing.
    mockRebase(() => {
      writeFileSync(
        join(repoUnderHome, 'path-map.json'),
        JSON.stringify({ projects: {}, sharedDirs: ['snippets'] }) + '\n',
      );
      mkdirSync(join(repoUnderHome, 'shared', 'snippets'), { recursive: true });
      writeFileSync(join(repoUnderHome, 'shared', 'snippets', 'note.md'), '# incoming\n');
    });

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();

    expect(existsSync(join(claudeDir, 'snippets', 'note.md'))).toBe(true);
    expect(readFileSync(join(claudeDir, 'snippets', 'note.md'), 'utf8')).toBe('# incoming\n');
  });

  it('reports one invalid sharedDirs entry exactly once on a posix wet pull', async () => {
    // Posix never runs the pre-rebase reconcile, so the post-rebase apply's
    // own derivation is the ONLY one that ever reports a rejected entry there.
    // Silencing it unconditionally would leave posix users with no signal at
    // all.
    stubPlatform('linux');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    mockRebase();

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();

    expect(rejectionWarns()).toHaveLength(1);
  });

  it('reports one invalid sharedDirs entry exactly once on a win32 wet pull', async () => {
    stubPlatform('win32');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    mockRebase();

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();

    expect(rejectionWarns()).toHaveLength(1);
  });

  it('reports one invalid sharedDirs entry exactly once on a recovered win32 pull', async () => {
    // On the recovered path, describeSkippedMirrorDiscard runs its own
    // allSharedLinks derivation purely to size its report-only tally; it must
    // stay quiet there, since the post-rebase apply's own derivation is the
    // only one whose job is to report a rejected entry. Both derivations run
    // within the same pull, so a loud report-only one duplicates the WARN.
    stubPlatform('win32');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    // Override the beforeEach's clean-repo wedge mock with a genuine wedge, as
    // above: unmock first, since re-registering vi.doMock for a specifier the
    // beforeEach already mocked, without an interceding vi.doUnmock, is a
    // documented race.
    vi.doUnmock('./commands.pull.wedge.ts');
    vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof wedgeModule>();
      return {
        ...actual,
        classifyWedge: vi.fn(() => 'rebase'),
        probeUnmergedIndex: vi.fn(() => 'clean'),
      };
    });
    vi.doMock('./commands.pull.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, recoverForceRemote: vi.fn() };
    });
    mockRebase();

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ forceRemote: true });

    expect(rejectionWarns()).toHaveLength(1);
  });

  it('reports one invalid sharedDirs entry exactly once on a win32 pull --dry-run', async () => {
    // The dry run adds two more derivations of its own (the pre-rebase plan
    // pair), and a user reading a preview has to be able to count rejected
    // entries by counting lines.
    stubPlatform('win32');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    mockRebase();

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ dryRun: true });

    expect(rejectionWarns()).toHaveLength(1);
  });

  it('still reports an invalid sharedDirs entry the rebase itself delivered, on win32', async () => {
    // The suppression decision is computed against the PRE-rebase map. When the
    // rebase brings the invalid entry in, the pre-rebase derivation had nothing
    // to say and the post-rebase one is the only one that can say it, so a
    // suppression carried blindly across the boundary silently drops the entry
    // and reports it ZERO times. Zero is a worse outcome than the duplicate the
    // suppression exists to remove.
    stubPlatform('win32');
    mockRebase(() => {
      writeFileSync(
        join(repoUnderHome, 'path-map.json'),
        JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
      );
    });

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();

    expect(rejectionWarns()).toHaveLength(1);
    expect(rejectionWarns()[0]).toContain('../escape');
  });

  it('reports the entry that survived the rebase, not the one it replaced, on win32', async () => {
    // Pre-rebase the map rejects A; the rebase swaps it for B. Both are worth
    // reporting (they describe two real repo states), but reporting A and never
    // B would leave the user chasing an entry that no longer exists while the
    // one actually being dropped goes unmentioned.
    stubPlatform('win32');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../before'] }) + '\n',
    );
    mockRebase(() => {
      writeFileSync(
        join(repoUnderHome, 'path-map.json'),
        JSON.stringify({ projects: {}, sharedDirs: ['../after'] }) + '\n',
      );
    });

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();

    // Two lines here is the honest count, not a regression of the duplicate
    // this suppression exists to remove: they name two different entries
    // against two different repo states, and the win32 pre-rebase reconcile
    // genuinely did reject the first one.
    expect(rejectionWarns()).toHaveLength(2);
    expect(rejectionWarns()[0]).toContain('../before');
    expect(rejectionWarns()[1]).toContain('../after');
  });

  it('still reports an invalid sharedDirs entry the rebase delivered, on a win32 dry run', async () => {
    // Same staleness, reached through the preview's plans object rather than
    // the wet path's flag.
    stubPlatform('win32');
    mockRebase(() => {
      writeFileSync(
        join(repoUnderHome, 'path-map.json'),
        JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
      );
    });

    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore({ dryRun: true });

    expect(rejectionWarns()).toHaveLength(1);
    expect(rejectionWarns()[0]).toContain('../escape');
  });
});
