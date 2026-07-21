import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as pushGlobalConfigModule from './push-global-config.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as recoveryModule from './commands.push.recovery.ts';
import type * as previewModule from './preview.ts';
import type * as wedgeModule from './commands.pull.wedge.ts';
import type * as extrasSyncModule from './extras-sync.ts';
import type * as lockfileModule from './utils.lockfile.ts';
import type * as utilsModule from './utils.ts';

import { EXIT } from './exit-codes.ts';

type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** Sandbox state for one cmdSync test. */
type SyncEnv = {
  originalHome: string | undefined;
  originalNomadHost: string | undefined;
  originalExitCode: typeof process.exitCode;
  testHome: string;
  repoUnderHome: string;
  lockPath: string;
  errSpy: LogSpy;
  logSpy: LogSpy;
};

/**
 * Build an isolated HOME sandbox for a cmdSync test: a temp HOME with a
 * scaffolded `claude-nomad/` repo (`shared/settings.base.json`, an empty
 * `path-map.json`), a `.claude/` host root, and spies on `console.error`,
 * `console.log`, and `process.stderr.write`. Resets the module cache so each
 * test loads a fresh `cmdSync`.
 */
function makeSyncEnv(): SyncEnv {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const originalExitCode = process.exitCode;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-sync-test-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  const repoUnderHome = join(testHome, 'claude-nomad');
  const lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
  mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
  writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
  mkdirSync(join(testHome, '.claude'), { recursive: true });
  writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
  vi.resetModules();
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    /* captured */
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    /* captured */
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    originalHome,
    originalNomadHost,
    originalExitCode,
    testHome,
    repoUnderHome,
    lockPath,
    errSpy,
    logSpy,
  };
}

/** Tear down a sandbox created by `makeSyncEnv`. */
function teardownSyncEnv(env: SyncEnv): void {
  vi.restoreAllMocks();
  vi.doUnmock('./commands.pull.ts');
  vi.doUnmock('./commands.push.ts');
  vi.doUnmock('./preview.ts');
  vi.doUnmock('./utils.lockfile.ts');
  vi.doUnmock('./push-checks.ts');
  vi.doUnmock('./remap.ts');
  vi.doUnmock('./extras-sync.ts');
  vi.doUnmock('./skills-sync.ts');
  vi.doUnmock('./utils.ts');
  vi.doUnmock('./push-global-config.ts');
  vi.doUnmock('./push-leak-verdict.ts');
  vi.doUnmock('./commands.push.recovery.ts');
  vi.doUnmock('node:child_process');
  process.exitCode = env.originalExitCode;
  if (env.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.originalHome;
  if (env.originalNomadHost === undefined) delete process.env.NOMAD_HOST;
  else process.env.NOMAD_HOST = env.originalNomadHost;
  rmSync(env.testHome, { recursive: true, force: true });
}

/** Stitch every recorded `console.log` call into one newline-joined string. */
function out(env: SyncEnv): string {
  return env.logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/** Stitch every recorded `console.error` call into one newline-joined string. */
function errOut(env: SyncEnv): string {
  return env.errSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

// ---------------------------------------------------------------------------
// cmdSync: preconditions and lock contention
// ---------------------------------------------------------------------------

describe('cmdSync preconditions and lock contention', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
  });

  it('dies with "repo not cloned at" when REPO_HOME does not exist on disk', async () => {
    rmSync(env.repoUnderHome, { recursive: true, force: true });
    const { cmdSync } = await import('./commands.sync.ts');
    await expect(cmdSync()).rejects.toThrow(/repo not cloned at/);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('dies with the init hint when shared/settings.base.json is absent', async () => {
    rmSync(join(env.repoUnderHome, 'shared', 'settings.base.json'), { force: true });
    const { cmdSync } = await import('./commands.sync.ts');
    await expect(cmdSync()).rejects.toThrow(/repo not initialized/);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('honors the lock-contention skip path (process.exit(0)) when acquireLock returns null', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const acquireSpy = vi.fn(() => null);
    vi.doMock('./utils.lockfile.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof lockfileModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdSync } = await import('./commands.sync.ts');
    await expect(cmdSync()).rejects.toThrow(/process\.exit:0/);
    expect(acquireSpy).toHaveBeenCalledWith('sync');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// cmdSync: wet composition (pull half then push half)
// ---------------------------------------------------------------------------

/** Minimal pull-side DoctorSection fixtures shared by the composition tests. */
function pullSections(
  opts: { sessionItem?: string; summaryText?: string; sessionExtraRows?: string[] } = {},
) {
  const settings = { header: 'Settings', items: ['settings.json (base + no host overrides)'] };
  const sessionItems = opts.sessionItem ? [opts.sessionItem] : [];
  if (opts.sessionExtraRows) sessionItems.push(...opts.sessionExtraRows);
  const sessions = { header: 'Sessions', items: sessionItems };
  const extras = { header: 'Extras', items: [] as string[] };
  const summary = { header: 'Pull summary', items: [opts.summaryText ?? 'clean'] };
  return [settings, sessions, extras, summary];
}

/** Minimal push-side compose-mode DoctorSection fixtures. */
function pushSideSections(opts: { sessionRows?: string[] } = {}) {
  return [
    { header: 'Sessions', items: opts.sessionRows ?? [] },
    { header: 'Leak scan', items: ['no leaks'] },
    { header: 'Push summary', items: ['clean'] },
  ];
}

/**
 * Build a full `runPullCore({ compose: true })`-shaped wet mock return,
 * carrying the outcome fields `buildSyncSummarySection` reads
 * (`settingsLabel`/`unmapped`/`extrasSkipped`) alongside the section
 * fixtures built by `pullSections`. Defaults produce a clean,
 * incoming-changes run with no host override.
 */
function wetPull(
  opts: {
    sessionItem?: string;
    summaryText?: string;
    sessionExtraRows?: string[];
    localOnly?: number;
    divergedKeptLocal?: number;
    incomingChanges?: boolean;
    settingsLabel?: string;
    unmapped?: number;
    extrasSkipped?: number;
  } = {},
) {
  return {
    tag: 'wet' as const,
    sections: pullSections({
      sessionItem: opts.sessionItem,
      summaryText: opts.summaryText,
      sessionExtraRows: opts.sessionExtraRows,
    }),
    localOnly: opts.localOnly ?? 0,
    divergedKeptLocal: opts.divergedKeptLocal ?? 0,
    incomingChanges: opts.incomingChanges ?? true,
    settingsLabel: opts.settingsLabel ?? 'no host overrides',
    unmapped: opts.unmapped ?? 0,
    extrasSkipped: opts.extrasSkipped ?? 0,
  };
}

/**
 * Build a `runPushCore({ compose: true })`-shaped `pushed` mock return,
 * carrying `globalConfigCount`/`collisions` alongside the section fixtures
 * built by `pushSideSections`.
 */
function pushedResult(
  opts: { sessionRows?: string[]; globalConfigCount?: number; collisions?: number } = {},
) {
  return {
    tag: 'pushed' as const,
    sections: pushSideSections({ sessionRows: opts.sessionRows }),
    globalConfigCount: opts.globalConfigCount ?? 0,
    collisions: opts.collisions ?? 0,
  };
}

/**
 * Build a `runPushCore({ compose: true })`-shaped `nothing` mock return,
 * carrying `globalConfigCount`/`collisions` alongside the optional
 * `aheadOfOrigin` flag and section fixtures.
 */
function nothingResult(
  opts: { aheadOfOrigin?: boolean; globalConfigCount?: number; collisions?: number } = {},
) {
  return {
    tag: 'nothing' as const,
    sections: pushSideSections(),
    ...(opts.aheadOfOrigin !== undefined ? { aheadOfOrigin: opts.aheadOfOrigin } : {}),
    globalConfigCount: opts.globalConfigCount ?? 0,
    collisions: opts.collisions ?? 0,
  };
}

describe('cmdSync: wet composition', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
  });

  it('happy path: compact default renders only the Sync summary composed from outcome data', async () => {
    const runPullCoreSpy = vi.fn(() => wetPull({ sessionItem: 'proj-a' }));
    const runPushCoreSpy = vi.fn(() => pushedResult());
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: runPullCoreSpy,
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: runPushCoreSpy,
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('Sync summary');
    expect(combined).toContain(
      'pull: upstream changes applied; settings regenerated (base + no host overrides)',
    );
    expect(combined).toContain('push: pushed');
    // Both halves ran in compose mode: cmdSync owns the single merged render.
    expect(runPullCoreSpy).toHaveBeenCalledWith({ compose: true });
    expect(runPushCoreSpy).toHaveBeenCalledWith({ compose: true });
    expect(process.exitCode).not.toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('compact default: prints no per-half section headers, only the Sync summary', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ sessionRows: ['pushed-proj'] })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const lines = out(env).split('\n');
    expect(lines).toContain('Sync summary');
    expect(lines).not.toContain('Settings');
    expect(lines).not.toContain('Sessions');
    expect(lines).not.toContain('Extras');
    expect(lines).not.toContain('Leak scan');
    expect(lines).not.toContain('Global config');
    const combined = out(env);
    expect(combined).not.toContain('proj-a');
    expect(combined).not.toContain('pushed-proj');
  });

  it('verbose: renders the full merged tree with per-half section headers before the Sync summary', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'pulled-proj' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ sessionRows: ['pushed-proj'] })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const lines = out(env).split('\n');
    expect(lines.filter((l) => l === 'Sessions')).toHaveLength(1);
    expect(lines).toContain('Sync summary');
    const combined = out(env);
    expect(combined).toContain('pulled-proj');
    expect(combined).toContain('pushed-proj');
    // Pull-then-push order within the merged Sessions section.
    expect(combined.indexOf('pulled-proj')).toBeLessThan(combined.indexOf('pushed-proj'));
    // The tree still renders before the Sync summary.
    expect(combined.indexOf('pulled-proj')).toBeLessThan(combined.indexOf('Sync summary'));
  });

  it('verbose: an identical not-in-path-map skip row from both halves appears exactly once', async () => {
    const skipRow = '2 not in path-map (run nomad doctor to list)';
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a', sessionExtraRows: [skipRow] })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ sessionRows: [skipRow] })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const lines = out(env).split('\n');
    expect(lines.filter((l) => l.includes(skipRow))).toHaveLength(1);
  });

  it('verbose: Pull summary and Push summary headers are dropped in favor of one Sync summary', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const lines = out(env).split('\n');
    expect(lines).not.toContain('Pull summary');
    expect(lines).not.toContain('Push summary');
    expect(lines).toContain('Sync summary');
  });

  it('exactly one sync-on-host header prints (compact default) and neither per-half header appears', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const lines = out(env).split('\n');
    expect(lines.filter((l) => l.includes('sync on host=test-host'))).toHaveLength(1);
    expect(out(env)).not.toContain('pull on host=');
    expect(out(env)).not.toContain('push on host=');
  });

  it('no-op: prints a single "already in sync" line, not two trees', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ incomingChanges: false })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'nothing' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('already in sync');
    expect(combined).not.toContain('pull:');
    expect(combined).not.toContain('push:');
    expect(process.exitCode).not.toBe(1);
  });

  it('no-op collapse fires even when the pull sections carry a synced Sessions row (regression)', async () => {
    // The overlay always re-copies mapped session dirs, so a non-empty
    // Sessions row does NOT by itself mean anything changed upstream; only
    // the rebase HEAD-delta signal (incomingChanges: false here) should
    // drive the collapse.
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a', incomingChanges: false })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'nothing' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('already in sync');
    expect(combined).not.toContain('pull:');
    expect(combined).not.toContain('push:');
    expect(combined).not.toContain('proj-a');
    expect(process.exitCode).not.toBe(1);
  });

  it('does not collapse when the push half reports unpushed sync-repo commits, and notes the state', async () => {
    // Clean worktree but HEAD ahead of upstream (e.g. a prior push committed
    // and the network push failed): asserting "already in sync" here would
    // mask exactly the state a sync run exists to surface.
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ incomingChanges: false })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => nothingResult({ aheadOfOrigin: true })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).not.toContain('already in sync');
    expect(combined).toContain('push: nothing to push');
    expect(combined).toContain('sync repo has unpushed commits');
    expect(process.exitCode).not.toBe(1);
  });

  it('verbose: a push-half header outside the canonical order survives after the canonical sections', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({
        ...pushedResult(),
        sections: [...pushSideSections(), { header: 'Path map', items: ['path-map.json missing'] }],
      })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const combined = out(env);
    expect(combined).toContain('Path map');
    expect(combined).toContain('path-map.json missing');
    // Unknown headers append after the canonical sections, never vanish.
    expect(combined.indexOf('Leak scan')).toBeLessThan(combined.indexOf('Path map'));
  });

  it('does not collapse when incomingChanges is true, even with an otherwise-clean push', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a', incomingChanges: true })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'nothing' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).not.toContain('already in sync');
    expect(combined).toContain('pull: upstream changes applied');
    expect(process.exitCode).not.toBe(1);
  });

  it('pull-half failure: does not call the push half, exits 1, surfaces the force-remote hint', async () => {
    const { NomadFatal } = await import('./utils.ts');
    const pushSpy = vi.fn(() => ({ tag: 'nothing' }));
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => {
        throw new NomadFatal(
          "repo is mid-rebase from a previous failed pull; run 'nomad pull --force-remote' to auto-recover",
        );
      }),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: pushSpy,
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errOut(env)).toContain('nomad pull --force-remote');
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('push-half failure after pull applied: prints the two-phase status and exits 1, no rollback', async () => {
    const { NomadFatal } = await import('./utils.ts');
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => {
        throw new NomadFatal('secret found');
      }),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const combined = out(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('pull: applied, push: failed (secret found)');
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('reconciled work: push row lists the nonzero parts (local-only, diverged, config) in one parenthetical', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() =>
        wetPull({ sessionItem: 'proj-a', localOnly: 3, divergedKeptLocal: 2 }),
      ),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ globalConfigCount: 1 })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain(
      'push: pushed (3 local-only sessions, 2 diverged extras files, 1 config file)',
    );
    expect(process.exitCode).not.toBe(1);
  });

  it('push row defaults a missing globalConfigCount to zero (defensive, tag "pushed" with no count field)', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull()),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'pushed', sections: pushSideSections() })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('push: pushed');
    expect(combined).not.toContain('push: pushed (');
  });

  it('push row omits the parenthetical entirely when every reconciled-work part is zero', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull()),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('push: pushed');
    expect(combined).not.toContain('push: pushed (');
  });

  it('push row lists only the config-files part when only globalConfigCount is nonzero', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull()),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ globalConfigCount: 4 })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('push: pushed (4 config files)');
  });

  it('verbose: a sections-less push result (resolved-leak arm) renders the pull tree alone without crashing', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'pushed', globalConfigCount: 1, collisions: 0 })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const combined = out(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('push: pushed (1 config file)');
    expect(process.exitCode).not.toBe(1);
  });

  it('defensive: a dry-tagged push result in a wet run renders "nothing to push" with no push sections', async () => {
    // The wet push half can never return the dry tag (cmdSync only passes
    // compose, never dryRun), but pushSectionsOf/buildPushSummaryRow must not
    // crash on it: the dry arm carries no sections and no counts.
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ sessionItem: 'proj-a' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'dry' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const combined = out(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('push: nothing to push');
    expect(process.exitCode).not.toBe(1);
  });

  it('a non-fatal error from the push half propagates unchanged (not swallowed)', async () => {
    const plainError = new Error('boom');
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ incomingChanges: false })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => {
        throw plainError;
      }),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await expect(cmdSync()).rejects.toThrow('boom');
    expect(process.exitCode).not.toBe(1);
  });

  it('pull row: reads "no upstream changes" when incomingChanges is false', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() =>
        wetPull({ incomingChanges: false, settingsLabel: 'test-host.json', localOnly: 1 }),
      ),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => nothingResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain(
      'pull: no upstream changes; settings regenerated (base + test-host.json)',
    );
    expect(combined).toContain('push: nothing to push');
    expect(process.exitCode).not.toBe(1);
  });

  it('pull row: reads "upstream changes applied" when incomingChanges is true', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ incomingChanges: true, settingsLabel: 'test-host.json' })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain(
      'pull: upstream changes applied; settings regenerated (base + test-host.json)',
    );
    expect(process.exitCode).not.toBe(1);
  });

  it('surfaces the combined unmapped count as a collapsed info row', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ unmapped: 4 })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('4 not in path-map (run nomad doctor to list)');
  });

  it('surfaces the extras-skipped count as a collapsed info row', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ extrasSkipped: 2 })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('2 extras skipped');
  });

  it('omits the skip/collision info rows entirely when every count is zero', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull()),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).not.toContain('not in path-map');
    expect(combined).not.toContain('extras skipped');
    expect(combined).not.toContain('collisions');
  });

  it('surfaces a nonzero push collision count as a warn row', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull()),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult({ collisions: 1 })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('1 collision (run nomad doctor to list)');
  });

  it('never repeats the stale pull-summary reconcile-advice phrase', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => wetPull({ localOnly: 5 })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => pushedResult()),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ verbose: true });
    const combined = out(env);
    expect(combined).not.toContain('push to reconcile');
  });
});

// ---------------------------------------------------------------------------
// cmdSync: dry-run composition
// ---------------------------------------------------------------------------

describe('cmdSync: dry-run composition', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
  });

  it('delegates the pull half to runPullCore dry mode before the push half, with a pre-pull caveat between them', async () => {
    const order: string[] = [];
    const runPullCoreSpy = vi.fn(() => {
      order.push('pull');
      return { tag: 'dry' };
    });
    const runPushCoreSpy = vi.fn(() => {
      order.push('push');
      return { tag: 'dry' };
    });
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: runPullCoreSpy,
    }));
    vi.doMock('./commands.push.ts', () => ({ runPushCore: runPushCoreSpy }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(runPullCoreSpy).toHaveBeenCalledWith({ dryRun: true });
    expect(runPushCoreSpy).toHaveBeenCalledWith({ dryRun: true });
    expect(order).toEqual(['pull', 'push']);
    expect(out(env)).toContain('computed against pre-pull state');
    expect(process.exitCode).not.toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('never calls computePreview itself: the pull preview is the pull half preview, not a second one', async () => {
    const pullPreviewSpy = vi.fn(() => ({ unmapped: 0, collisions: 0, localOnly: 0 }));
    vi.doMock('./preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof previewModule>();
      return { ...actual, computePreview: pullPreviewSpy };
    });
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({ tag: 'dry' })),
    }));
    vi.doMock('./commands.push.ts', () => ({ runPushCore: vi.fn(() => ({ tag: 'dry' })) }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(pullPreviewSpy).not.toHaveBeenCalled();
  });

  it('acquires the sync lock for the dry-run path too', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(),
    }));
    vi.doMock('./commands.push.ts', () => ({ runPushCore: vi.fn(() => ({ tag: 'dry' })) }));
    const acquireSpy = vi.fn(() => null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    vi.doMock('./utils.lockfile.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof lockfileModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdSync } = await import('./commands.sync.ts');
    await expect(cmdSync({ dryRun: true })).rejects.toThrow(/process\.exit:0/);
    expect(acquireSpy).toHaveBeenCalledWith('sync');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// cmdSync: dry-run runs the real pull half (post-fetch preview + both checks)
// ---------------------------------------------------------------------------

/** Recorded seam calls plus the spies a post-fetch dry-run test asserts on. */
type DrySeams = {
  order: string[];
  classifyWedgeSpy: MockInstance<(repo: string) => unknown>;
  divergenceSpy: MockInstance<(...args: unknown[]) => number>;
  previewSpy: MockInstance<(...args: unknown[]) => unknown>;
  pushSpy: MockInstance<(...args: unknown[]) => unknown>;
  /** Repo-state string `computePreview` observed at the moment it ran. */
  seenAtPreview: { value: string };
};

/**
 * Mock the seams the REAL `runPullCore` dry path reaches, recording the order
 * they fire in. `onFetch` runs inside the mocked `git pull --rebase` so a test
 * can mutate repo state mid-run and prove the preview observed the post-fetch
 * value. `classifyWedge` returns `wedge` (default `null`, a clean repo).
 *
 * @param env - The active sandbox.
 * @param opts.wedge - `classifyWedge`'s return value.
 * @param opts.onFetch - Side effect performed by the mocked fetch.
 * @returns The recorded order array and the individual spies.
 */
function mockDrySeams(
  env: SyncEnv,
  opts: { wedge?: unknown; onFetch?: () => void } = {},
): DrySeams {
  const order: string[] = [];
  const statePath = join(env.repoUnderHome, 'upstream-state.txt');
  const seenAtPreview = { value: '' };
  const classifyWedgeSpy = vi.fn(() => {
    order.push('classifyWedge');
    return opts.wedge ?? null;
  });
  const divergenceSpy = vi.fn(() => {
    order.push('divergenceCheckExtras');
    return 0;
  });
  const previewSpy = vi.fn(() => {
    order.push('computePreview');
    seenAtPreview.value = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
    return { unmapped: 0, collisions: 0, localOnly: 0 };
  });
  const pushSpy = vi.fn(() => {
    order.push('runPushCore');
    return { tag: 'dry' };
  });
  vi.doMock('./commands.pull.wedge.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof wedgeModule>();
    return { ...actual, classifyWedge: classifyWedgeSpy };
  });
  vi.doMock('./utils.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof utilsModule>();
    return {
      ...actual,
      gitCaptureRaw: vi.fn(() => 'deadbeef\n'),
      gitOrFatal: vi.fn(() => {
        order.push('fetch');
        opts.onFetch?.();
      }),
    };
  });
  vi.doMock('./extras-sync.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof extrasSyncModule>();
    return { ...actual, divergenceCheckExtras: divergenceSpy };
  });
  vi.doMock('./preview.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof previewModule>();
    return { ...actual, computePreview: previewSpy };
  });
  vi.doMock('./commands.push.ts', () => ({ runPushCore: pushSpy }));
  return { order, classifyWedgeSpy, divergenceSpy, previewSpy, pushSpy, seenAtPreview };
}

describe('cmdSync --dry-run: real pull half', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
    vi.doUnmock('./commands.pull.wedge.ts');
  });

  it('computes the pull preview AFTER the fetch, not against pre-fetch repo state', async () => {
    const statePath = join(env.repoUnderHome, 'upstream-state.txt');
    writeFileSync(statePath, 'before');
    const seams = mockDrySeams(env, {
      onFetch: () => {
        writeFileSync(statePath, 'after');
      },
    });
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(seams.seenAtPreview.value).toBe('after');
    expect(seams.order).toEqual([
      'classifyWedge',
      'fetch',
      'divergenceCheckExtras',
      'computePreview',
      'runPushCore',
    ]);
  });

  it('runs the divergenceCheckExtras preview check the wet sync and nomad diff both run', async () => {
    const seams = mockDrySeams(env);
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(seams.divergenceSpy).toHaveBeenCalledTimes(1);
    // Dry mode threads the pre/post-rebase HEAD pair through so the
    // delete-vs-edit keep-local WARN can render in the preview.
    expect(seams.divergenceSpy).toHaveBeenCalledWith(expect.any(String), {
      pre: 'deadbeef',
      post: 'deadbeef',
    });
  });

  it('runs the handleWedge preflight: a mid-rebase repo dies before any preview renders', async () => {
    const seams = mockDrySeams(env, { wedge: 'rebase' });
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(seams.classifyWedgeSpy).toHaveBeenCalledTimes(1);
    expect(seams.previewSpy).not.toHaveBeenCalled();
    expect(seams.divergenceSpy).not.toHaveBeenCalled();
    expect(seams.pushSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT.CONFLICT);
    expect(errOut(env)).toMatch(/rebase/i);
    // The lock is still released on the fatal path.
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('closes with exactly one dry-run complete line, after the push preview', async () => {
    mockDrySeams(env);
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });

    const lines = out(env).split('\n');
    const completes = lines.filter((l) => l.includes('dry-run complete'));
    // runPullCore leaves the closing line to its caller, so the pull half must
    // not emit one mid-stream where it would read as the command ending.
    expect(completes).toHaveLength(1);
    const completeAt = lines.findIndex((l) => l.includes('dry-run complete'));
    const pushNoticeAt = lines.findIndex((l) => l.includes('push preview below'));
    expect(pushNoticeAt).toBeGreaterThanOrEqual(0);
    expect(completeAt).toBeGreaterThan(pushNoticeAt);
  });

  it('falls back to an empty path-map when path-map.json is absent', async () => {
    rmSync(join(env.repoUnderHome, 'path-map.json'), { force: true });
    const seams = mockDrySeams(env);
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(seams.previewSpy).toHaveBeenCalledWith(expect.any(String), { projects: {} }, 'pull');
  });
});

// ---------------------------------------------------------------------------
// cmdSync: mid-push leak reuses the standalone push TTY recovery loop
// ---------------------------------------------------------------------------

describe('cmdSync: mid-push leak recovery reuse', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
    vi.doUnmock('./push-checks.ts');
  });

  it('a mid-push leak on a TTY resolves through the unchanged push recovery module', async () => {
    // The pull half is stubbed clean so this test isolates the push half's
    // leak path. The push half runs FOR REAL (not mocked): a leak verdict on
    // the first scan routes into commands.push.recovery.ts's
    // resolveLeakFindings, which this test replaces with a spy that resolves
    // the finding and returns a clean verdict, proving cmdSync's push
    // composition reaches the exact same recovery entry point standalone
    // `nomad push` uses.
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections(),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 0, skipped: 0, pushed: [], wouldPush: [] })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./skills-sync.ts', () => ({
      syncSkillsPush: vi.fn(),
      syncSkillsPull: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => `M  shared/CLAUDE.md\0`) };
    });
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    const leakVerdict = {
      leak: true,
      verdictRow: '✗ 1 leak found',
      recovery: 'recovery body',
      findings: [],
    };
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return { ...actual, scanPushVerdict: vi.fn(() => leakVerdict) };
    });
    const resolveLeakFindingsSpy = vi.fn(() => ({
      leak: false,
      verdictRow: '✓ no leaks',
      recovery: null,
      findings: [],
    }));
    vi.doMock('./commands.push.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, resolveLeakFindings: resolveLeakFindingsSpy };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    expect(resolveLeakFindingsSpy).toHaveBeenCalledWith(
      leakVerdict,
      expect.any(String),
      { projects: {} },
      expect.objectContaining({ redactAll: false, allowAll: false, allowRule: undefined }),
    );
    expect(process.exitCode).not.toBe(1);
  });
});
