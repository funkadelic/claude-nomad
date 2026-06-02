import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePushEnv, teardownPushEnv, type PushEnv } from './commands.push.test-helpers.ts';

import type * as pushChecksModule from './push-checks.ts';
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
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush({ dryRun: true })).not.toThrow();
    expect(remapExtrasPushMock).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
  });
});
