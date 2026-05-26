import { existsSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errOutput,
  logOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as utilsModule from './utils.ts';

// Coverage for cmdPush's gitleaks-scan stage: a detection on the staged tree
// unwinds to a FATAL with the lock released, and the dry-run path skips the
// scan (and the rest of the staging quartet) entirely. Shares the cmdPush
// pipeline harness (makePushEnv) with the boundary-gate suite.
describe('cmdPush Phase 3 push-boundary safety', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('Test 5: gitleaks detection on scan -> FATAL; lock released', async () => {
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', async () => {
      const { NomadFatal } = await import('./utils.ts');
      return {
        runGitleaksScan: vi.fn(() => {
          throw new NomadFatal(
            'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry',
          );
        }),
      };
    });
    // Make gitStatusPorcelainZ report a single allow-listed modification so
    // the flow reaches the scan step (the early-return short-circuit only
    // fires on an empty index).
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    // The temp REPO is not a real git repo, so the inline `git add -A` would
    // fail before the scan step. Mock node:child_process so all execFileSync
    // calls become deterministic no-ops returning an empty Buffer.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    expect(errOutput(env)).toMatch(/gitleaks detected secrets/);
  });

  it('Test 8a: cmdPush({ dryRun: true }) skips git add / scan / commit / push and still emits summary', async () => {
    // Dry-run preview: probeGitleaks + rebase + remap (in dryRun) + gitlink
    // scan + status read + allow-list classification all run, but the
    // staging quartet (git add, runGitleaksScan, git commit, git push) is
    // skipped. The summary line still fires with the remapPush counts so
    // the user gets a consistent terminator.
    const runGitleaksScanMock = vi.fn(() => {
      /* should not be invoked */
    });
    const gitOrFatalMock = vi.fn(() => {
      /* should not be invoked for add/commit/push */
    });
    const remapPushMock = vi.fn(() => ({ unmapped: 2, collisions: 0 }));
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: runGitleaksScanMock,
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: remapPushMock,
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Non-empty status: the dryRun branch should fire AFTER the
        // allow-list pass, not bypass the early-return-on-empty path.
        gitStatusPorcelainZ: vi.fn(() => ' M shared/CLAUDE.md\0'),
        gitOrFatal: gitOrFatalMock,
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush({ dryRun: true })).not.toThrow();
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(existsSync(env.lockPath)).toBe(false);
    // remapPush received { dryRun: true } so no host-encoded copies landed.
    expect(remapPushMock).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
    // Staging quartet skipped.
    expect(runGitleaksScanMock).not.toHaveBeenCalled();
    expect(gitOrFatalMock).not.toHaveBeenCalled();
    const out = logOutput(env);
    expect(out).toContain('pushing on host=test-host (dry-run)');
    expect(out).toContain('push: dry-run; skipping git add, gitleaks scan, commit, and push');
    // unmapped-style summary now goes to warn() (console.error).
    expect(errOutput(env)).toContain(
      '⚠︎ summary: 2 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(out).not.toContain('push complete');
    vi.doUnmock('./remap.ts');
  });
});
