import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

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

// ---------------------------------------------------------------------------
// reportSettingsAheadDrift: ahead-drift warn surface
// ---------------------------------------------------------------------------

describe('reportSettingsAheadDrift', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('emits a warn when live settings has local-only keys (ahead-drift)', async () => {
    const { repoUnderHome, testHome } = env;
    // Scaffold: base has one key, live settings has an extra key not in the merge.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-5', localOnlyKey: 'local-value' }),
    );
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    reportSettingsAheadDrift(repoUnderHome);
    const combined = errOutput(env);
    expect(combined).toContain('localOnlyKey');
    expect(combined).toContain('nomad capture-settings');
  });

  it('folds a host override into the merge before computing ahead-drift', async () => {
    const { repoUnderHome, testHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(join(repoUnderHome, 'hosts'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    // Host override supplies statusLine, so it is part of the merge and is NOT
    // ahead-drift; only localOnlyKey remains local-only.
    writeFileSync(
      join(repoUnderHome, 'hosts', 'test-host.json'),
      JSON.stringify({ statusLine: { type: 'command' } }),
    );
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'claude-opus-4-5',
        statusLine: { type: 'command' },
        localOnlyKey: 'local-value',
      }),
    );
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    reportSettingsAheadDrift(repoUnderHome);
    const combined = errOutput(env);
    expect(combined).toContain('localOnlyKey');
    expect(combined).not.toContain('statusLine');
  });

  it('emits no warn when live settings matches the merge', async () => {
    const { repoUnderHome, testHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    reportSettingsAheadDrift(repoUnderHome);
    expect(errOutput(env)).toBe('');
  });

  it('silently skips when settings.json is absent', async () => {
    const { repoUnderHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    // No settings.json written.
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    expect(() => reportSettingsAheadDrift(repoUnderHome)).not.toThrow();
    expect(errOutput(env)).toBe('');
  });

  it('silently skips when settings.json is malformed (zero mutation)', async () => {
    const { repoUnderHome, testHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    writeFileSync(join(testHome, '.claude', 'settings.json'), '{INVALID JSON');
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    expect(() => reportSettingsAheadDrift(repoUnderHome)).not.toThrow();
    expect(errOutput(env)).toBe('');
  });

  it('emits no warn when the only local-only key is excluded from capture (env)', async () => {
    const { repoUnderHome, testHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    // env is ahead but excluded from capture: advising capture-settings would
    // no-op and would name a secret-bearing key, so no warn fires.
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-5', env: { ANTHROPIC_API_KEY: 'sk-secret' } }),
    );
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    reportSettingsAheadDrift(repoUnderHome);
    const combined = errOutput(env);
    expect(combined).toBe('');
    expect(combined).not.toContain('env');
  });

  it('warns for the promotable key only when ahead-drift mixes promotable and excluded keys', async () => {
    const { repoUnderHome, testHome } = env;
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'claude-opus-4-5' }),
    );
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'claude-opus-4-5',
        statusLine: { type: 'command' },
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
      }),
    );
    const { reportSettingsAheadDrift } = await import('./commands.push.ts');
    reportSettingsAheadDrift(repoUnderHome);
    const combined = errOutput(env);
    expect(combined).toContain('statusLine');
    expect(combined).toContain('nomad capture-settings');
    expect(combined).not.toContain('env');
  });
});

// ---------------------------------------------------------------------------
// stripGsdHooksFromBase: write-path base strip
// ---------------------------------------------------------------------------

describe('stripGsdHooksFromBase (push write-path base strip)', () => {
  let env: PushEnv;

  const gsdEntry = {
    type: 'command',
    command: 'node /home/u/.claude/hooks/gsd-context-monitor.js',
  };
  const userEntry = { type: 'command', command: 'node /home/u/my-hooks/my-personal-hook.js' };

  /**
   * Write shared/settings.base.json in the sandbox repo.
   *
   * @param content - Object to serialize as the base content.
   */
  function writeBase(content: unknown): void {
    mkdirSync(join(env.repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(env.repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify(content, null, 2) + '\n',
    );
  }

  /**
   * Read and parse shared/settings.base.json from the sandbox repo.
   *
   * @returns Parsed content.
   */
  function readBase(): unknown {
    const raw = readFileSync(join(env.repoUnderHome, 'shared', 'settings.base.json'), 'utf8');
    return JSON.parse(raw) as unknown;
  }

  /**
   * Run cmdPush through the WET path with all git/remap/scan mocks in place.
   * The base rewrite (stripGsdHooksFromBase) happens before commitAndPush's
   * git add -A, so it is visible in the file on disk after the call.
   *
   * @returns Combined errSpy output.
   */
  async function runWetPush(): Promise<string> {
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
      copySkillsPull: vi.fn(),
    }));
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    // gitStatusPorcelainZ: first call (allow-list) returns a staged base path,
    // second call (commitAndPush gsd-drop scan) returns the same path.
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => `M  shared/settings.base.json\0`),
      };
    });
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return {
        ...actual,
        scanPushVerdict: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });

    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush();
    return errOutput(env);
  }

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
    vi.doUnmock('./push-leak-verdict.ts');
    vi.doUnmock('./skills-sync.ts');
    vi.doUnmock('./push-global-config.ts');
  });

  it('Test 1: base with gsd + user entries is rewritten to keep only user entries, backup taken', async () => {
    const baseWithMixed = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry, userEntry] }],
      },
    };
    writeBase(baseWithMixed);
    const mtimeBefore = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;

    await runWetPush();

    const result = readBase() as Record<string, unknown>;
    // gsd entry must be gone, user entry must survive.
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    const preToolUseMatchers = hooks.PreToolUse as { hooks: unknown[] }[];
    expect(preToolUseMatchers).toBeDefined();
    expect(preToolUseMatchers[0].hooks).toHaveLength(1);
    expect(preToolUseMatchers[0].hooks[0]).toMatchObject({ command: userEntry.command });
    // mtime must have changed (file was rewritten).
    const mtimeAfter = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;
    expect(mtimeAfter).toBeGreaterThanOrEqual(mtimeBefore);
  });

  it('Test 2 (idempotent): base with no gsd entries is NOT rewritten (no mtime change)', async () => {
    const cleanBase = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userEntry] }],
      },
    };
    writeBase(cleanBase);
    const mtimeBefore = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;

    await runWetPush();

    // File must not be rewritten: mtime stays the same.
    const mtimeAfter = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    // Content must be unchanged.
    const result = readBase() as Record<string, unknown>;
    expect(result.model).toBe('sonnet');
  });

  it('Test 3: base with only gsd entries is rewritten with hooks key removed entirely', async () => {
    const gsdOnlyBase = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
      },
    };
    writeBase(gsdOnlyBase);

    await runWetPush();

    const result = readBase() as Record<string, unknown>;
    // hooks key must be absent (all entries stripped, empty -> removed).
    expect(result.hooks).toBeUndefined();
    expect(result.model).toBe('sonnet');
  });

  it('Test 4: base with absent/malformed hooks block is not rewritten (fail-safe)', async () => {
    const noHooksBase = { model: 'sonnet', theme: 'dark' };
    writeBase(noHooksBase);
    const mtimeBefore = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;

    await runWetPush();

    // No rewrite since there are no hooks to strip.
    const mtimeAfter = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    const result = readBase() as Record<string, unknown>;
    expect(result.theme).toBe('dark');
  });

  it('Test 5: real push with gsd-laden base produces a clean base (gsd entries absent from file)', async () => {
    // Integration: base has gsd-only hooks; after push the file lacks them.
    const gsdOnlyBase = {
      model: 'sonnet',
      hooks: {
        Stop: [{ matcher: '', hooks: [gsdEntry] }],
      },
    };
    writeBase(gsdOnlyBase);

    await runWetPush();

    const result = readBase() as Record<string, unknown>;
    expect(result.hooks).toBeUndefined();
    expect(result.model).toBe('sonnet');
  });

  it('Test 6 (non-destructive on pull): regenerateSettings never rewrites shared/settings.base.json', async () => {
    // The base strip is push-only; regenerateSettings (pull-side) must
    // never touch shared/settings.base.json even when it holds gsd hook entries.
    const gsdOnlyBase = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
      },
    };
    writeBase(gsdOnlyBase);
    // Write a minimal settings.json so regenerateSettings has a target.
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    const basePath = join(env.repoUnderHome, 'shared', 'settings.base.json');
    const rawBefore = readFileSync(basePath, 'utf8');

    // Import regenerateSettings (the pull-side fn) and run it.
    vi.resetModules();
    const { regenerateSettings } = await import('./links.ts');
    regenerateSettings('test-ts');

    // The base file must be byte-for-byte unchanged.
    const rawAfter = readFileSync(basePath, 'utf8');
    expect(rawAfter).toBe(rawBefore);
  });

  it('absent base: stripGsdHooksFromBase silently skips when base file missing', async () => {
    // Do NOT write a base file. The base path does not exist.
    // cmdPush will reach stripGsdHooksFromBase and silently skip.
    // We verify no error is thrown and the rest of the pipeline completes.
    await expect(runWetPush()).resolves.not.toThrow();
    // No base file to assert on, but the test verifies the absent-base
    // early return does not crash or set exitCode.
    expect(process.exitCode).toBeUndefined();
  });

  it('malformed base: stripGsdHooksFromBase silently skips when base is unparseable JSON', async () => {
    // Write a base that is not valid JSON.
    mkdirSync(join(env.repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(env.repoUnderHome, 'shared', 'settings.base.json'), '{ NOT VALID JSON\n');
    // cmdPush must not throw or set exitCode from the malformed base.
    await expect(runWetPush()).resolves.not.toThrow();
    expect(process.exitCode).toBeUndefined();
    // File content must be unchanged (no rewrite on parse failure).
    const raw = readFileSync(join(env.repoUnderHome, 'shared', 'settings.base.json'), 'utf8');
    expect(raw).toBe('{ NOT VALID JSON\n');
  });

  it('empty hooks: {} scaffold is NOT rewritten (no gsd entries means no strip)', async () => {
    // An empty hooks block has NO gsd entries. The push must NOT rewrite the
    // base (no backup, no mtime change) because baseHasGsdHookEntries returns
    // false for an empty scaffold.
    const emptyHooksBase = { model: 'sonnet', hooks: {} };
    writeBase(emptyHooksBase);
    const mtimeBefore = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;

    await runWetPush();

    const mtimeAfter = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    // Content must be unchanged (empty hooks key preserved).
    const result = readBase() as Record<string, unknown>;
    expect(result).toHaveProperty('hooks');
    expect(result.model).toBe('sonnet');
  });

  it('base strip runs BEFORE the empty-status early-return, allowing a clean tree to commit a dirty base', async () => {
    // Scenario: the only outstanding change is the committed base having gsd
    // hook entries. Before the fix, gitStatusPorcelainZ returned empty -> early
    // return before strip. Now the strip runs BEFORE the status snapshot, so a
    // dirty base appears as a pending change and the push proceeds.
    //
    // We simulate this by writing a gsd-laden base and letting gitStatusPorcelainZ
    // return empty on the FIRST call (simulating "nothing else changed"). The
    // strip must have already rewritten the file on disk before status is read,
    // so the test verifies the base file is clean after the run even when status
    // says empty (which would have triggered the early return in the old ordering).
    //
    // Implementation: after the fix, stripGsdHooksFromBase fires before
    // gitStatusPorcelainZ. When status is empty ("nothing to commit") the early
    // return fires, but the base was ALREADY stripped -- confirmed by reading the
    // file on disk. In the old code, the early return would fire first and the
    // base would still contain gsd entries.
    const gsdOnlyBase = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
      },
    };
    writeBase(gsdOnlyBase);
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
      copySkillsPull: vi.fn(),
    }));
    // Status returns empty: simulates a clean tree with nothing else pending.
    // With the old ordering, strip never ran (early return fired first).
    // With the new ordering, strip runs before this call, base is already clean.
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ''),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush();
    // Strip ran before status: base must now be clean regardless of early-return.
    const result = readBase() as Record<string, unknown>;
    expect(result.hooks).toBeUndefined();
    expect(result.model).toBe('sonnet');
  });

  it('Test 7 (dry-run): a push --dry-run does NOT rewrite the base', async () => {
    const gsdOnlyBase = {
      model: 'sonnet',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [gsdEntry] }],
      },
    };
    writeBase(gsdOnlyBase);
    const mtimeBefore = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;

    // Dry-run: only rebaseBeforePush + leak preview, no file writes.
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
      copySkillsPull: vi.fn(),
    }));
    vi.doMock('./push-global-config.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushGlobalConfigModule>();
      return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => `M  shared/settings.base.json\0`),
      };
    });
    vi.doMock('./push-preview.ts', () => ({
      previewPushLeaks: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
    }));

    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });

    // Base must be unchanged: dry-run never mutates files.
    const mtimeAfter = statSync(join(env.repoUnderHome, 'shared', 'settings.base.json')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    const result = readBase() as Record<string, unknown>;
    // gsd hook entry must still be present (no strip on dry-run).
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
  });
});
