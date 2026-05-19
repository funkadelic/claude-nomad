import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as utilsModule from './utils.ts';

// NomadFatal is loaded dynamically inside each test AFTER vi.resetModules()
// + vi.doMock so the class reference shared with the freshly-loaded
// commands.push.ts is the same identity (instanceof in cmdPush's catch must
// recognize the error thrown from the mock factory).

type ErrSpy = MockInstance<(...args: unknown[]) => void>;
type LogSpy = MockInstance<(...args: unknown[]) => void>;

// Integration coverage for cmdPush's safety-check ordering:
//   probeGitleaks -> rebaseBeforePush -> remapPush -> findGitlinks ->
//   allow-list -> git add -> runGitleaksScan -> git commit -> git push.
// Each FATAL path also proves the lockfile is released via the existing
// try/catch/finally (zero infrastructure change).
describe('cmdPush Phase 3 push-boundary safety', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;
  let errSpy: ErrSpy;
  let logSpy: LogSpy;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-push-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    // The gitlink walk needs shared/ to exist (findGitlinks is tolerant of
    // a missing dir but the explicit dir keeps the integration realistic).
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    // path-map.json must be present so cmdPush's existsSync(mapPath) check
    // passes when the flow reaches the allow-list step (Test 5).
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
    // Spies capture output without polluting test logs.
    errSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((_chunk) => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./push-checks.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('node:child_process');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  // Helper: stitch all console.error spy call arguments into one string so a
  // regex /match/ assertion can survey the whole output regardless of how
  // many calls were made.
  function errOutput(): string {
    return errSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }
  function logOutput(): string {
    return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

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
        runGitleaksScan: runGitleaksScanMock,
      };
    });
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
    expect(existsSync(lockPath)).toBe(false);
    // The early-return path fired, proving probe/rebase/gitlinks all ran
    // successfully (otherwise one of them would have thrown).
    expect(logOutput()).toMatch(/nothing to commit/);
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
        runGitleaksScan: vi.fn(() => {
          /* no-op success */
        }),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
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
        runGitleaksScan: vi.fn(() => {
          /* no-op success */
        }),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
    expect(out).toMatch(/gitleaks not on PATH/);
    expect(out).toMatch(/Install:/);
  });

  it('Test 4: gitlink hit -> per-hit FATAL + summary FATAL; lock released', async () => {
    const hitPath = join(repoUnderHome, 'shared', 'evil', '.git');
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => [hitPath]),
        runGitleaksScan: vi.fn(() => {
          /* no-op success */
        }),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
    // Per-hit line uses the rel-from-REPO_HOME path.
    expect(out).toMatch(/FATAL: gitlink: shared\/evil\/\.git/);
    // Summary throw counts hits with singular "entry" for count === 1.
    expect(out).toMatch(/gitlink trap: 1 nested \.git entry in shared\//);
  });

  it('Test 5: gitleaks detection on scan -> FATAL; lock released', async () => {
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      const { NomadFatal } = await import('./utils.ts');
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => []),
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
    expect(existsSync(lockPath)).toBe(false);
    expect(errOutput()).toMatch(/gitleaks detected secrets/);
  });
});
