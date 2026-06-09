import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePushEnv, teardownPushEnv, type PushEnv } from './commands.push.test-helpers.ts';

import type * as pushChecksModule from './push-checks.ts';
import type * as pushAllowlistModule from './commands.push.allowlist.ts';
import type * as pushGlobalConfigModule from './push-global-config.ts';
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
