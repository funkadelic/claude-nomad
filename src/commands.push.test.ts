import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePushEnv, teardownPushEnv, type PushEnv } from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as pushAllowlistModule from './commands.push.allowlist.ts';
import type * as pushGlobalConfigModule from './push-global-config.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as utilsModule from './utils.ts';

// ---------------------------------------------------------------------------
// cmdPush: defense-in-depth mutual-exclusivity guard
// ---------------------------------------------------------------------------

class DieError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DieError';
  }
}

describe('cmdPush: guardResolutionModeConflicts defense-in-depth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.ts');
  });

  it('throws (via die) when --redact-all and --allow-all are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ redactAll: true, allowAll: true })).rejects.toThrow(DieError);
  });

  it('throws (via die) when --redact-all and --allow <rule> are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ redactAll: true, allowRule: 'github-pat' })).rejects.toThrow(DieError);
  });

  it('throws (via die) when --allow-all and --allow <rule> are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ allowAll: true, allowRule: 'github-pat' })).rejects.toThrow(DieError);
  });

  it('throws (via die) when --dry-run and --allow-all are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ dryRun: true, allowAll: true })).rejects.toThrow(DieError);
  });

  it('throws (via die) when --dry-run and --allow <rule> are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ dryRun: true, allowRule: 'github-pat' })).rejects.toThrow(DieError);
  });

  it('throws (via die) when --dry-run and --redact-all are both set', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ dryRun: true, redactAll: true })).rejects.toThrow(DieError);
  });
});

// cmdPush integration: the `remapExtrasPush` call lands between `remapPush`
// and `findGitlinks` so the produced `shared/extras/...` paths are visible to
// the allow-list classification on the resulting `git status`. The integration
// mocks the remap functions so the test does not depend on host disk state and
// proves the call site fires before the gitlink walk runs.
describe('cmdPush: extras pipeline integration', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('calls remapExtrasPush after remapPush and before the gitlink walk', async () => {
    // Track the relative order of remapPush, remapExtrasPush, findGitlinks.
    // The required order: remapPush -> remapExtrasPush -> findGitlinks.
    const callOrder: string[] = [];
    const remapPushMock = vi.fn(() => {
      callOrder.push('remapPush');
      return { unmapped: 0, collisions: 0, pushed: [], wouldPush: [] };
    });
    const remapExtrasPushMock = vi.fn(() => {
      callOrder.push('remapExtrasPush');
      return { unmapped: 0, skipped: 0, pushed: [], wouldPush: [] };
    });
    const findGitlinksMock = vi.fn(() => {
      callOrder.push('findGitlinks');
      return [];
    });
    writeFileSync(
      join(env.repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { foo: ['.planning'] } }) + '\n',
    );
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
        findGitlinks: findGitlinksMock,
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: remapPushMock,
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: remapExtrasPushMock,
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ''),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(remapExtrasPushMock).toHaveBeenCalled();
    // The required call-order invariant: remapExtrasPush is between remapPush
    // and findGitlinks.
    expect(callOrder).toEqual(['remapPush', 'remapExtrasPush', 'findGitlinks']);
  });

  it('passes dryRun through to remapExtrasPush', async () => {
    const remapExtrasPushMock = vi.fn(() => ({
      unmapped: 0,
      skipped: 0,
      pushed: [],
      wouldPush: [],
    }));
    writeFileSync(
      join(env.repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { foo: ['.planning'] } }) + '\n',
    );
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: remapExtrasPushMock,
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ''),
      };
    });
    // Stub collectGlobalConfigChanges so the dry-run preview does not invoke
    // real git diff against the temp repo (which has no HEAD commit).
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush({ dryRun: true })).not.toThrow();
    expect(remapExtrasPushMock).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
  });
});

// ---------------------------------------------------------------------------
// cmdPush: safety-pipeline logic survivors (L178/L181/L98/L240/L253/L260/L266)
// ---------------------------------------------------------------------------

/**
 * Minimal pipeline mock for a cmdPush that proceeds past the safety guards.
 * Sets up push-checks (probeGitleaks, rebaseBeforePush, findGitlinks),
 * remap.ts, extras-sync.ts, and utils.ts with a non-empty status so the
 * allow-list step runs.
 */
function mockPipelineBase(
  opts: {
    statusLine?: string;
    enforceAllowListFn?: ReturnType<typeof vi.fn>;
    dryRunVerdictRecovery?: string | null;
  } = {},
) {
  const status = opts.statusLine ?? '';
  vi.doMock('./push-checks.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushChecksModule>();
    return {
      ...actual,
      probeGitleaks: vi.fn(() => 'v8.18.2'),
      rebaseBeforePush: vi.fn(() => {
        /* no-op */
      }),
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
  if (opts.enforceAllowListFn !== undefined) {
    vi.doMock('./commands.push.allowlist.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushAllowlistModule>();
      return { ...actual, enforceAllowList: opts.enforceAllowListFn };
    });
  }
  vi.doMock('./utils.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof utilsModule>();
    return {
      ...actual,
      gitStatusPorcelainZ: vi.fn(() => status),
    };
  });
  // Stub collectGlobalConfigChanges so tests that reach the dry-run preview
  // or commitAndPush do not invoke real git diff against a non-git temp dir.
  vi.doMock('./push-global-config.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushGlobalConfigModule>();
    return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
  });
}

describe('cmdPush: guardResolutionModeConflicts exact-boundary tests (L178/L181)', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('does NOT die when only --redact-all is set (no --allow flag) (kills L178 LogicalOperator)', async () => {
    // L178 mutates `redactAll && hasAllow` -> `redactAll || hasAllow`. With just
    // redactAll=true, original guard is false (no-die); mutant is true (dies).
    // Providing a pipeline that completes normally proves the original guard does
    // not fire for redactAll-only.
    mockPipelineBase();
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    const { cmdPush } = await import('./commands.push.ts');
    // The pipeline proceeds past the guard. probeGitleaks, rebaseBeforePush, etc.
    // all run. Empty status returns "nothing to commit" without hitting git add.
    await expect(cmdPush({ redactAll: true })).resolves.toBeUndefined();
  });

  it('does NOT die when only --allow-all is set (no --redact-all, no --allow) (kills L181 ConditionalExpression/LogicalOperator)', async () => {
    // L181 `if (allowAll && allowRule !== undefined)` mutated to `true` would
    // always die. With allowAll=true and no allowRule, original guard is false.
    mockPipelineBase();
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ allowAll: true })).resolves.toBeUndefined();
  });
});

describe('cmdPush: status-based allow-list guard (L240/L260)', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('calls enforceAllowList when status is non-empty (kills L260 ConditionalExpression false)', async () => {
    // L260 `if (status) enforceAllowList(...)` mutated to `false` would skip the
    // allow-list even when status is non-empty. Test proves enforceAllowList is
    // called on a non-empty status line.
    const enforceAllowListMock = vi.fn(() => {
      /* allow */
    });
    // A status line that looks like an untracked file.
    mockPipelineBase({
      statusLine: '?? shared/path-map.json\0',
      enforceAllowListFn: enforceAllowListMock,
    });
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    const { cmdPush } = await import('./commands.push.ts');
    // cmdPush runs past the guard; enforceAllowList is called.
    await cmdPush({ dryRun: true });
    expect(enforceAllowListMock).toHaveBeenCalled();
  });

  it('does NOT call enforceAllowList when status is empty (kills L260 ConditionalExpression true)', async () => {
    // L260 mutated to `true` would call enforceAllowList even on an empty status.
    // With empty status (dryRun on a clean repo), enforceAllowList must NOT run.
    const enforceAllowListMock = vi.fn(() => {
      /* allow */
    });
    mockPipelineBase({ statusLine: '', enforceAllowListFn: enforceAllowListMock });
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    expect(enforceAllowListMock).not.toHaveBeenCalled();
  });

  it('passes untrackedAll: true to gitStatusPorcelainZ (kills L240 ObjectLiteral/BooleanLiteral)', async () => {
    // L240 `gitStatusPorcelainZ(repo, { untrackedAll: true })` mutated to pass
    // `{}` or `{ untrackedAll: false }` drops the flag. Verify the flag is forwarded.
    let capturedOpts: Record<string, unknown> | undefined;
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn((_repo: string, opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return '';
        }),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    expect(capturedOpts).toEqual({ untrackedAll: true });
  });
});

describe('cmdPush: dry-run no-map die path (L253)', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('calls die when map is missing and dryRun is false (kills L253 ConditionalExpression true)', async () => {
    // L253 `if (dryRun) return runDryRunPreview(st, null)` mutated to `true`
    // would skip the die() on a real (non-dry) push with no path-map. Remove the
    // map so the no-map branch is taken, then call without dryRun.
    class DieError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'DieError';
      }
    }
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Return a non-empty status so the early 'nothing to commit' return is skipped.
        gitStatusPorcelainZ: vi.fn(() => 'M shared/path-map.json\0'),
        die: (msg: string) => {
          throw new DieError(msg);
        },
      };
    });
    // Remove path-map.json so existsSync(mapPath) is false.
    const { existsSync, rmSync } = await import('node:fs');
    const mapPath = join(env.repoUnderHome, 'path-map.json');
    if (existsSync(mapPath)) rmSync(mapPath);
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ dryRun: false })).rejects.toThrow(DieError);
  });
});

describe('cmdPush: NomadFatal catch boundary (L266)', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('re-throws non-NomadFatal errors unchanged (kills L266 ConditionalExpression true)', async () => {
    // L266 `if (err instanceof NomadFatal)` mutated to `true` would swallow all
    // errors. A plain Error (not NomadFatal) thrown from probeGitleaks must
    // propagate past cmdPush's try/catch without being caught.
    const plainError = new Error('probe plain error');
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => {
          throw plainError;
        }),
      };
    });
    vi.doMock('./remap.ts', () => ({ remapPull: vi.fn(), remapPush: vi.fn() }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).rejects.toThrow('probe plain error');
    // exitCode must NOT be set to 1 (NomadFatal path sets exitCode; plain re-throw doesn't).
    expect(process.exitCode).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cmdPush: skills pipeline integration (syncSkillsPush wired between
// remapExtrasPush and guardGitlinks, WET-only)
// ---------------------------------------------------------------------------

describe('cmdPush: skills pipeline integration', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('WET push: user skill staged under shared/skills, local gsd-* excluded', async () => {
    // End-to-end: syncSkillsPush is called on the WET path. A user skill in
    // ~/.claude/skills is copied to shared/skills; a gsd-* skill is excluded.
    const localSkills = join(env.testHome, '.claude', 'skills');
    const sharedSkills = join(env.repoUnderHome, 'shared', 'skills');
    mkdirSync(localSkills, { recursive: true });
    writeFileSync(join(localSkills, 'pr-feedback-sweep'), '# pr feedback\n');
    writeFileSync(join(localSkills, 'gsd-foo'), '# gsd skill\n');
    mkdirSync(sharedSkills, { recursive: true });

    const syncSkillsPushMock = vi.fn();
    vi.doMock('./skills-sync.ts', () => ({
      syncSkillsPull: vi.fn(),
      syncSkillsPush: syncSkillsPushMock,
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).resolves.toBeUndefined();

    // syncSkillsPush called on WET path.
    expect(syncSkillsPushMock).toHaveBeenCalled();
  });

  it('dry-run push: syncSkillsPush is NOT called (zero-mutation contract)', async () => {
    // dryRun forwards false to syncSkillsPush via the `if (!dryRun)` guard,
    // so no files are written to shared/skills on a dry-run.
    const syncSkillsPushMock = vi.fn();
    vi.doMock('./skills-sync.ts', () => ({
      syncSkillsPull: vi.fn(),
      syncSkillsPush: syncSkillsPushMock,
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush({ dryRun: true })).resolves.toBeUndefined();

    // dry-run: syncSkillsPush must NOT have been called.
    expect(syncSkillsPushMock).not.toHaveBeenCalled();
  });

  it('WET push: syncSkillsPush is called after remapExtrasPush (call order)', async () => {
    // The order: remapExtrasPush -> syncSkillsPush -> guardGitlinks.
    // Proves the call site is between extras and the gitlink walk.
    const callOrder: string[] = [];
    const syncSkillsPushMock = vi.fn(() => {
      callOrder.push('syncSkillsPush');
    });
    vi.doMock('./skills-sync.ts', () => ({
      syncSkillsPull: vi.fn(),
      syncSkillsPush: syncSkillsPushMock,
    }));
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(),
        findGitlinks: vi.fn(() => {
          callOrder.push('findGitlinks');
          return [];
        }),
      };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => {
        callOrder.push('remapExtrasPush');
        return { unmapped: 0, skipped: 0, pushed: [], wouldPush: [] };
      }),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).resolves.toBeUndefined();

    expect(callOrder).toEqual(['remapExtrasPush', 'syncSkillsPush', 'findGitlinks']);
  });

  it('WET push: real syncSkillsPush copies user skill and excludes gsd-* from shared/skills', async () => {
    // Exercise the real syncSkillsPush (not mocked) to verify the filter works
    // end-to-end through the push pipeline. Checks that shared/skills gets the
    // user skill and the gsd-* stays out.
    const localSkills = join(env.testHome, '.claude', 'skills');
    const sharedSkills = join(env.repoUnderHome, 'shared', 'skills');
    mkdirSync(localSkills, { recursive: true });
    writeFileSync(join(localSkills, 'pr-feedback-sweep'), '# pr feedback\n');
    writeFileSync(join(localSkills, 'gsd-foo'), '# gsd skill\n');
    mkdirSync(sharedSkills, { recursive: true });

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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).resolves.toBeUndefined();

    // User skill copied to shared/skills.
    expect(existsSync(join(sharedSkills, 'pr-feedback-sweep'))).toBe(true);
    // gsd-* excluded from shared/skills.
    expect(existsSync(join(sharedSkills, 'gsd-foo'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdPush: gsd-dropped unstage in commitAndPush (issue #294 commit-suppression)
// ---------------------------------------------------------------------------
// Verifies that commitAndPush calls `git restore --staged` for gsd-dropped paths
// so they are removed from the index before commit. The first gitStatusPorcelainZ
// call (in cmdPush body, untrackedAll:true) returns an allow-listed path so the
// flow proceeds past the early-return. The second call (inside commitAndPush,
// no untrackedAll) returns a gsd-dropped path, triggering the restore branch.

describe('cmdPush: gsd-dropped paths are unstaged before commit (issue #294)', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
    vi.doUnmock('./push-leak-verdict.ts');
  });

  it('calls git restore --staged for gsd-dropped paths but still commits real changes', async () => {
    // Two gitStatusPorcelainZ calls in the WET push path:
    //   call 1 (cmdPush body, untrackedAll:true): allow-list classification.
    //   call 2 (commitAndPush, no untrackedAll): staged-tree scan for gsd drop.
    // Call 1 returns an allow-listed path so the flow does NOT short-circuit.
    // Call 2 returns a gsd-prefixed hook path AND a real staged session path, so
    // toDrop is non-empty (restore fires) but staged.length > toDrop.length, so
    // the empty-index short-circuit does NOT fire and the commit proceeds.
    let statusCallCount = 0;
    const gsdPath = 'shared/hooks/gsd-prompt-guard.js';
    const realPath = 'shared/projects/demo/0001.jsonl';
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Call 1: allow-listed path for the pre-stage allow-list check.
        // Call 2: gsd-dropped path + a real staged path for the post-add-A scan.
        gitStatusPorcelainZ: vi.fn(() => {
          statusCallCount++;
          if (statusCallCount === 1) return `M  shared/CLAUDE.md\0`;
          return `A  ${gsdPath}\0A  ${realPath}\0`;
        }),
      };
    });
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return {
        ...actual,
        scanPushVerdict: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
      };
    });
    // Mock execFileSync so git commands (add -A, restore --staged, commit, push)
    // do not touch the real filesystem. Capture calls to verify restore --staged.
    const execFileSyncCalls: string[][] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn((...args: unknown[]) => {
          const argv = args as [string, string[], ...unknown[]];
          if (argv[0] === 'git') execFileSyncCalls.push(argv[1]);
          return Buffer.from('');
        }),
      };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).resolves.toBeUndefined();

    // Verify git restore --staged was called with the gsd-dropped path only.
    const restoreCall = execFileSyncCalls.find(
      (args) => args[0] === 'restore' && args[1] === '--staged',
    );
    expect(restoreCall).toBeDefined();
    expect(restoreCall).toContain(gsdPath);
    expect(restoreCall).not.toContain(realPath);
    // git add -A must have fired before the restore.
    const addCall = execFileSyncCalls.find((args) => args[0] === 'add' && args[1] === '-A');
    expect(addCall).toBeDefined();
    // A real staged change remains, so the commit must still proceed.
    const commitCall = execFileSyncCalls.find((args) => args[0] === 'commit');
    expect(commitCall).toBeDefined();
  });

  it('does not commit an empty index when the gsd payload is the only change (issue #294)', async () => {
    // Pure #294 repro: a fresh host whose sole pending change is gsd's per-host
    // reinstall. Both status calls return only gsd-dropped paths, so after the
    // restore the index is empty. commitAndPush must short-circuit cleanly rather
    // than run `git commit` on an empty index (which would throw NomadFatal).
    let statusCallCount = 0;
    const gsdHook = 'shared/hooks/gsd-prompt-guard.js';
    const gsdAgent = 'shared/agents/gsd-debug.md';
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Both calls return only gsd-dropped paths: the allow-list classification
        // passes (silent skip) and the post-add-A staged set is entirely gsd.
        gitStatusPorcelainZ: vi.fn(() => {
          statusCallCount++;
          return `A  ${gsdHook}\0A  ${gsdAgent}\0`;
        }),
      };
    });
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return {
        ...actual,
        scanPushVerdict: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
      };
    });
    const execFileSyncCalls: string[][] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn((...args: unknown[]) => {
          const argv = args as [string, string[], ...unknown[]];
          if (argv[0] === 'git') execFileSyncCalls.push(argv[1]);
          return Buffer.from('');
        }),
      };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await expect(cmdPush()).resolves.toBeUndefined();

    // restore --staged fired for the gsd paths, but no commit / push followed.
    const restoreCall = execFileSyncCalls.find(
      (args) => args[0] === 'restore' && args[1] === '--staged',
    );
    expect(restoreCall).toBeDefined();
    expect(restoreCall).toContain(gsdHook);
    expect(restoreCall).toContain(gsdAgent);
    expect(execFileSyncCalls.find((args) => args[0] === 'commit')).toBeUndefined();
    expect(execFileSyncCalls.find((args) => args[0] === 'push')).toBeUndefined();
    expect(statusCallCount).toBe(2);
  });
});
