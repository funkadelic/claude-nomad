import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as pushGlobalConfigModule from './push-global-config.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as recoveryModule from './commands.push.recovery.ts';
import type * as previewModule from './preview.ts';
import type * as lockfileModule from './utils.lockfile.ts';
import type * as utilsModule from './utils.ts';

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

describe('cmdSync: wet composition', () => {
  let env: SyncEnv;

  beforeEach(() => {
    env = makeSyncEnv();
  });

  afterEach(() => {
    teardownSyncEnv(env);
  });

  it('happy path: renders one merged tree then a two-phase Sync summary with pull/push rows', async () => {
    const runPullCoreSpy = vi.fn(() => ({
      tag: 'wet',
      sections: pullSections({
        sessionItem: 'proj-a',
        summaryText: '1 unmapped on pull (run nomad doctor to list)',
      }),
      localOnly: 0,
      divergedKeptLocal: 0,
      incomingChanges: true,
    }));
    const runPushCoreSpy = vi.fn(() => ({ tag: 'pushed', sections: pushSideSections() }));
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
    expect(combined).toContain('proj-a');
    expect(combined).toContain('pull: 1 unmapped on pull (run nomad doctor to list)');
    expect(combined).toContain('push: pushed');
    // Both halves ran in compose mode: cmdSync owns the single merged render.
    expect(runPullCoreSpy).toHaveBeenCalledWith({ compose: true });
    expect(runPushCoreSpy).toHaveBeenCalledWith({ compose: true });
    expect(process.exitCode).not.toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('merged tree: a Sessions row from each half renders under a single Sessions header', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'pulled-proj' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({
        tag: 'pushed',
        sections: pushSideSections({ sessionRows: ['pushed-proj'] }),
      })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const lines = out(env).split('\n');
    expect(lines.filter((l) => l === 'Sessions')).toHaveLength(1);
    const combined = out(env);
    expect(combined).toContain('pulled-proj');
    expect(combined).toContain('pushed-proj');
    // Pull-then-push order within the merged Sessions section.
    expect(combined.indexOf('pulled-proj')).toBeLessThan(combined.indexOf('pushed-proj'));
  });

  it('merged tree: an identical not-in-path-map skip row from both halves appears exactly once', async () => {
    const skipRow = '2 not in path-map (run nomad doctor to list)';
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a', sessionExtraRows: [skipRow] }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({
        tag: 'pushed',
        sections: pushSideSections({ sessionRows: [skipRow] }),
      })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const lines = out(env).split('\n');
    expect(lines.filter((l) => l.includes(skipRow))).toHaveLength(1);
  });

  it('merged tree: Pull summary and Push summary headers are dropped in favor of one Sync summary', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'pushed', sections: pushSideSections() })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const lines = out(env).split('\n');
    expect(lines).not.toContain('Pull summary');
    expect(lines).not.toContain('Push summary');
    expect(lines).toContain('Sync summary');
  });

  it('merged tree: exactly one sync-on-host header prints and neither per-half header appears', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'pushed', sections: pushSideSections() })),
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
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections(),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: false,
      })),
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
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: false,
      })),
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

  it('does not collapse when incomingChanges is true, even with an otherwise-clean push', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'nothing' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).not.toContain('already in sync');
    expect(combined).toContain('proj-a');
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
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => {
        throw new NomadFatal('secret found');
      }),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('pull: applied, push: failed (secret found)');
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('reconciled notes: divergence kept-local and local-only render as resolved and exit 0', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 3,
        divergedKeptLocal: 2,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'pushed', sections: pushSideSections() })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('2 diverged files kept local and pushed');
    expect(combined).toContain('3 local-only sessions pushed');
    expect(process.exitCode).not.toBe(1);
  });

  it('defensive: a dry-tagged push result in a wet run renders with no push sections', async () => {
    // The wet push half can never return the dry tag (cmdSync only passes
    // compose, never dryRun), but pushSectionsOf must not crash on it: the
    // dry arm carries no sections, so the merged tree gets none.
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections({ sessionItem: 'proj-a' }),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: true,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'dry' })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('push: nothing to push');
    expect(process.exitCode).not.toBe(1);
  });

  it('a non-fatal error from the push half propagates unchanged (not swallowed)', async () => {
    const plainError = new Error('boom');
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: pullSections(),
        localOnly: 0,
        divergedKeptLocal: 0,
        incomingChanges: false,
      })),
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

  it('falls back to "applied" for the pull row when the pull sections carry no Pull summary', async () => {
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(() => ({
        tag: 'wet',
        sections: [{ header: 'Settings', items: ['settings.json (base + no host overrides)'] }],
        localOnly: 1,
        divergedKeptLocal: 0,
        incomingChanges: false,
      })),
    }));
    vi.doMock('./commands.push.ts', () => ({
      runPushCore: vi.fn(() => ({ tag: 'nothing', sections: pushSideSections() })),
    }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync();
    const combined = out(env);
    expect(combined).toContain('pull: applied');
    expect(combined).toContain('push: nothing to push');
    expect(process.exitCode).not.toBe(1);
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

  it('stacks the pull preview then the push preview with a pre-pull caveat, and never touches the wet cores', async () => {
    const pullPreviewSpy = vi.fn(() => ({ unmapped: 0, collisions: 0, localOnly: 0 }));
    const runPullCoreSpy = vi.fn();
    const runPushCoreSpy = vi.fn(() => ({ tag: 'dry' }));
    vi.doMock('./preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof previewModule>();
      return { ...actual, computePreview: pullPreviewSpy };
    });
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: runPullCoreSpy,
    }));
    vi.doMock('./commands.push.ts', () => ({ runPushCore: runPushCoreSpy }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(pullPreviewSpy).toHaveBeenCalledWith(expect.any(String), { projects: {} }, 'pull');
    expect(runPullCoreSpy).not.toHaveBeenCalled();
    expect(runPushCoreSpy).toHaveBeenCalledWith({ dryRun: true });
    expect(out(env)).toContain('computed against pre-pull state');
    expect(process.exitCode).not.toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('falls back to an empty path-map when path-map.json is absent', async () => {
    rmSync(join(env.repoUnderHome, 'path-map.json'), { force: true });
    const pullPreviewSpy = vi.fn(() => ({ unmapped: 0, collisions: 0, localOnly: 0 }));
    vi.doMock('./preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof previewModule>();
      return { ...actual, computePreview: pullPreviewSpy };
    });
    vi.doMock('./commands.pull.ts', () => ({
      PULL_SUMMARY_HEADER: 'Pull summary',
      runPullCore: vi.fn(),
    }));
    vi.doMock('./commands.push.ts', () => ({ runPushCore: vi.fn(() => ({ tag: 'dry' })) }));
    const { cmdSync } = await import('./commands.sync.ts');
    await cmdSync({ dryRun: true });
    expect(pullPreviewSpy).toHaveBeenCalledWith(expect.any(String), { projects: {} }, 'pull');
  });

  it('acquires the sync lock for the dry-run path too', async () => {
    vi.doMock('./preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof previewModule>();
      return {
        ...actual,
        computePreview: vi.fn(() => ({ unmapped: 0, collisions: 0, localOnly: 0 })),
      };
    });
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
