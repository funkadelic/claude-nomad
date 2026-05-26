import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errOutput,
  logOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as pushChecksModule from './push-checks.ts';
import type * as utilsModule from './utils.ts';

// Integration coverage for cmdPush's pre-staging safety gates in order:
//   probeGitleaks -> rebaseBeforePush -> remapPush -> findGitlinks ->
//   allow-list -> git add -> runGitleaksScan.
// Each FATAL path also proves the lockfile is released via the existing
// try/catch/finally (zero infrastructure change).
describe('cmdPush Phase 3 push-boundary safety', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('Test 1: clean push proceeds; runGitleaksScan is NOT called on empty index', async () => {
    // The scan mock is declared at outer scope so its call count survives
    // the dynamic import of ./commands.push.ts.
    const runGitleaksScanMock = vi.fn(() => {
      /* no-op success */
    });
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
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ''),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(existsSync(env.lockPath)).toBe(false);
    // The early-return path fired, proving probe/rebase/gitlinks all ran
    // successfully (otherwise one of them would have thrown).
    expect(logOutput(env)).toMatch(/nothing to commit/);
    // The scan must NOT be invoked when the index is empty. A future
    // refactor that accidentally moves runGitleaksScan above the early
    // return will fail this assertion.
    expect(runGitleaksScanMock).not.toHaveBeenCalled();
  });

  it('Test 2: rebase fails -> FATAL with corrected wording; lock released', async () => {
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      // Import NomadFatal here so it shares identity with the copy that
      // freshly-loaded commands.push.ts catches via `instanceof`.
      const { NomadFatal } = await import('./utils.ts');
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          throw new NomadFatal(
            'rebase failed; if a conflict was reported, resolve it in ~/claude-nomad/ and run "git rebase --continue" (or "git rebase --abort" to give up). Re-run nomad push after resolution.',
          );
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    const out = errOutput(env);
    expect(out).toMatch(/rebase failed/);
    expect(out).toMatch(/git rebase --continue/);
    // Negative-assertion via regex-in-variable: corrected wording must not
    // point users at the legacy stash-list recovery path. The pattern lives
    // in a variable so the substring stays out of plain top-level prose.
    const stashListRecoveryPattern = /git stash list/;
    expect(out).not.toMatch(stashListRecoveryPattern);
  });

  it('Test 3: gitleaks ENOENT on probe -> FATAL with install hint; lock released', async () => {
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      const { NomadFatal } = await import('./utils.ts');
      return {
        ...actual,
        probeGitleaks: vi.fn(() => {
          throw new NomadFatal(actual.gitleaksInstallHint());
        }),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    const out = errOutput(env);
    expect(out).toMatch(/gitleaks not on PATH/);
    expect(out).toMatch(/Install:/);
  });

  it('Test 4: gitlink hit -> per-hit FATAL + summary FATAL; lock released', async () => {
    const hitPath = join(env.repoUnderHome, 'shared', 'evil', '.git');
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => [hitPath]),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    const out = errOutput(env);
    // Per-hit line uses the rel-from-REPO_HOME path.
    expect(out).toMatch(/gitlink: shared\/evil\/\.git/);
    // Summary throw counts hits with singular "entry" for count === 1.
    expect(out).toMatch(/gitlink trap: 1 nested \.git entry in shared\//);
  });
});
