import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/** Run a git command in `cwd`, surfacing stderr on failure. Test-only helper
 * for the real-repo regression suites (no production code path uses it). */
function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

import type * as childProcessModule from 'node:child_process';
import type { PathMap } from './config.ts';
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
    vi.doUnmock('./push-gitleaks.ts');
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
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
    // Per-hit line uses the rel-from-REPO_HOME path.
    expect(out).toMatch(/gitlink: shared\/evil\/\.git/);
    // Summary throw counts hits with singular "entry" for count === 1.
    expect(out).toMatch(/gitlink trap: 1 nested \.git entry in shared\//);
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
    expect(existsSync(lockPath)).toBe(false);
    expect(errOutput()).toMatch(/gitleaks detected secrets/);
  });

  it('Test 6: cmdPush emits the unmapped-on-push summary line after push complete', async () => {
    // remapPush stubbed to report 1 unmapped + 0 collisions. The summary line
    // MUST appear AFTER `push complete` and reflect both counts.
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
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 1, collisions: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
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
    expect(() => cmdPush()).not.toThrow();
    // `push complete` goes to log (stdout); the unmapped-style summary now
    // goes through warn() (stderr / console.error).
    expect(errOutput()).toContain(
      '⚠︎ summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(logOutput()).toContain('push complete');
    vi.doUnmock('./remap.ts');
  });

  it('Test 7: cmdPush emits the clean summary line on a successful push with zero unmapped and zero collisions', async () => {
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
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
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
    expect(() => cmdPush()).not.toThrow();
    expect(logOutput()).toMatch(/✓ +summary: clean/);
    vi.doUnmock('./remap.ts');
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
    expect(existsSync(lockPath)).toBe(false);
    // remapPush received { dryRun: true } so no host-encoded copies landed.
    expect(remapPushMock).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
    // Staging quartet skipped.
    expect(runGitleaksScanMock).not.toHaveBeenCalled();
    expect(gitOrFatalMock).not.toHaveBeenCalled();
    const out = logOutput();
    expect(out).toContain('pushing on host=test-host (dry-run)');
    expect(out).toContain('push: dry-run; skipping git add, gitleaks scan, commit, and push');
    // unmapped-style summary now goes to warn() (console.error).
    expect(errOutput()).toContain(
      '⚠︎ summary: 2 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(out).not.toContain('push complete');
    vi.doUnmock('./remap.ts');
  });

  it('Test 8: cmdPush emits the summary line on the nothing-to-commit early-return path', async () => {
    // gitStatusPorcelainZ returns empty, triggering the `log('nothing to
    // commit'); return;` branch. remapPush has already run, so its counts
    // are in scope. The summary line MUST still appear so users see a
    // consistent terminator even on no-op pushes.
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
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 3, collisions: 0 })),
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
    expect(logOutput()).toContain('nothing to commit');
    // unmapped-style summary now goes to warn() (console.error).
    expect(errOutput()).toContain(
      '⚠︎ summary: 3 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    vi.doUnmock('./remap.ts');
  });

  it('Test 9: cmdPush dies with "repo not cloned at" FATAL when REPO_HOME absent (no lockfile created)', async () => {
    // Remove the repo dir created by beforeEach so the line-134 precondition
    // (`if (!existsSync(REPO_HOME))`) fires BEFORE acquireLock. Critical: no
    // lockfile must land on disk because the precondition is before the lock
    // acquisition. The precondition uses `die` which throws NomadFatal; the
    // current cmdPush body only catches inside the try block (which is AFTER
    // acquireLock), so this fatal escapes to the test as a thrown error.
    rmSync(repoUnderHome, { recursive: true, force: true });
    expect(existsSync(repoUnderHome)).toBe(false);
    const { cmdPush } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdPush()).toThrow(NomadFatal);
    expect(() => cmdPush()).toThrow(/repo not cloned at/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('Test 10: cmdPush reports plural "entries" when findGitlinks returns 2 or more hits', async () => {
    // Mirror Test 4 (singular "entry") but return two gitlink hits. The
    // summary throw at line 165 uses `count === 1 ? 'entry' : 'entries'`;
    // the plural branch was previously uncovered.
    const hit1 = join(repoUnderHome, 'shared', 'a', '.git');
    const hit2 = join(repoUnderHome, 'shared', 'b', '.git');
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => [hit1, hit2]),
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
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
    // Per-hit lines for both, plus the plural summary FATAL.
    expect(out).toMatch(/gitlink: shared\/a\/\.git/);
    expect(out).toMatch(/gitlink: shared\/b\/\.git/);
    expect(out).toMatch(/gitlink trap: 2 nested \.git entries in shared\//);
  });

  it('gitleaks detection on a session JSONL -> FATAL names the session id and drop-session hint; lock released', async () => {
    // Session-aware end-to-end: runGitleaksScan throws a session-aware
    // NomadFatal naming a synthetic session id + drop-session hint;
    // cmdPush's catch block routes the message through console.error with
    // the ✗ prefix, sets exitCode=1, and the finally block
    // releases the lock. The unit tests in push-gitleaks.test.ts cover the
    // builder shape; this test asserts the message propagates through the
    // command boundary intact.
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
            [
              'gitleaks detected secrets in 1 session transcript(s).',
              '',
              'Session abc12345-test-fixture:',
              '  generic-api-key (1)',
              '  Recover with: nomad drop-session abc12345-test-fixture',
              '',
              'After recovery, re-run nomad push.',
            ].join('\n'),
          );
        }),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Non-empty status so the flow reaches the scan step.
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/projects/foo/sid.jsonl\0'),
      };
    });
    // The temp REPO is not a real git repo, so the inline `git add -A`
    // would fail before the scan step. Mock node:child_process so all
    // execFileSync calls become deterministic no-ops returning empty.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    // path-map.json must reference the logical so enforceAllowList does
    // not reject `shared/projects/foo/sid.jsonl` before the scan runs.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    const out = errOutput();
    expect(out).toContain('✗ ');
    expect(out).toContain('abc12345-test-fixture');
    expect(out).toContain('nomad drop-session');
  });
});

// Coverage for the settings.local.json NEVER_SYNC entry added to config.ts.
// settings.local.json is Anthropic's per-host overrides file; it must hard-block
// at the push boundary even if it somehow lands in the repo tree (e.g. an
// accidental copy of ~/.claude/ into shared/). Sibling case to the .claude.json
// NEVER_SYNC coverage in commands.test.ts; lives here so the push-boundary test
// surface keeps every NEVER_SYNC entry of immediate push concern in one file.
describe('enforceAllowList NEVER_SYNC settings.local.json', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects settings.local.json as NEVER_SYNC at repo root AND under shared/', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Porcelain -z records for untracked files. NUL-terminated to match
    // git status -z output (parsePorcelainZ splits on \0). The shared/
    // case is the load-bearing one for this PR: defense-in-depth against an
    // accidental copy of ~/.claude/settings.local.json into the synced tree.
    const map: PathMap = { projects: {} };
    for (const status of ['?? settings.local.json\0', '?? shared/settings.local.json\0']) {
      expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('settings.local.json is in NEVER_SYNC and must never be pushed'),
    );
  });
});

// parsePorcelainZ is the pure parser used by enforceAllowList. Its Y-column
// rename and trailing-rename-without-pair edges are not exercised by the
// cmdPush integration tests above (which use simple `M  ...` records). These
// tests target lines 55 (Y-column R/C detection) and 67 (oldPath defined
// guard) directly so the allow-list enforcement remains correct under git's
// less common porcelain shapes.
describe('parsePorcelainZ Y-column and trailing-rename edges', () => {
  it('detects R in the Y-column (working-tree status) and returns both new+old paths', async () => {
    // ` R new\0old\0` is a working-tree rename: index column is space, Y is R.
    // Both halves must be returned so the allow-list can reject either side.
    // Missing line 55's R/C check on Y would skip the consume and let the
    // next iteration misread the old path as a new record.
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const status = ' R new-path\0old-path\0';
    expect(parsePorcelainZ(status)).toEqual(['new-path', 'old-path']);
  });

  it('detects C in the Y-column and returns both new+old paths', async () => {
    // Symmetric to the R case; copy records carry the same dual-path shape.
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const status = ' C copy-dst\0copy-src\0';
    expect(parsePorcelainZ(status)).toEqual(['copy-dst', 'copy-src']);
  });

  it('does NOT throw when an R record is the last record with no paired old-path', async () => {
    // `R  new-path\0` (no trailing old-path record). Line 67's
    // `oldPath !== undefined && oldPath !== ''` guard prevents pushing
    // undefined into the paths array; the `i++` still consumes a virtual
    // slot, the loop terminates cleanly, and the function returns [new].
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const status = 'R  new-path\0';
    expect(parsePorcelainZ(status)).toEqual(['new-path']);
  });

  it('does NOT push an empty-string old-path when the trailing record is empty', async () => {
    // `R  new\0\0` -> records split = ['R  new', '', '']. The R record at
    // index 0 sees records[1] = '' which is excluded by the
    // `oldPath !== ''` half of line 67's guard, so the old slot is skipped.
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const status = 'R  new\0\0';
    expect(parsePorcelainZ(status)).toEqual(['new']);
  });

  it('handles a normal X-column R (index rename) followed by old path correctly (baseline)', async () => {
    // Baseline regression guard: the X-column rename case must still work
    // identically to the Y-column case. This guarantees we did not skew the
    // common path while wiring the Y-column branch.
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const status = 'R  new\0old\0';
    expect(parsePorcelainZ(status)).toEqual(['new', 'old']);
  });

  it('skips a record shorter than 4 chars (line 55 guard against malformed porcelain)', async () => {
    // Records under 4 chars cannot hold "XY <path>" (2 status + 1 space + 1
    // path char minimum). A truncated/garbled record like "XY" must be
    // silently skipped, not throw, not push an empty string. Covers
    // line-55 branch in parsePorcelainZ.
    const { parsePorcelainZ } = await import('./commands.push.ts');
    // First record is a valid "M  ok" path; second is too short ("XY"); the
    // parser should keep the valid path and ignore the truncated record.
    const status = 'M  ok\0XY\0';
    expect(parsePorcelainZ(status)).toEqual(['ok']);
  });
});

// Covers commands.push.ts line 136: the lock-contention skip path for
// cmdPush, symmetric to cmdPull's contention skip covered in
// commands.pull.test.ts. acquireLock returns null -> process.exit(0).
describe('cmdPush lock-contention skip path', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpush-lockskip-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(repoUnderHome, { recursive: true });
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
    vi.doUnmock('./utils.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('calls process.exit(0) when acquireLock returns null', async () => {
    // Spy on process.exit so the test can assert on it without exiting.
    // Mock acquireLock to return null; cmdPush's line 136 should then
    // exit(0) before entering the try block (no NomadFatal, no exitCode=1).
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const acquireSpy = vi.fn(() => null);
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).toThrow(/process\.exit:0/);
    expect(acquireSpy).toHaveBeenCalledWith('push');
    expect(exitSpy).toHaveBeenCalledWith(0);
    // No real lockfile because the mock never wrote one.
    expect(existsSync(lockPath)).toBe(false);
  });
});

// Extras allow-list widening: `enforceAllowList` builds its runtime allowed
// array by spreading `Object.keys(map.extras ?? {})` into one prefix per
// declared logical, mirroring the existing `shared/projects/<logical>/`
// pattern. A staged path under a declared logical passes; one under an
// unmapped logical (no `extras` entry for that name) fails with the existing
// `to sync ... add to PUSH_ALLOWED` FATAL. Data-driven by construction so
// Pitfall 4 (allow-list bypass via crafted `shared/extras/` path) is closed.
describe('enforceAllowList: extras prefix', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('permits shared/extras/<logical>/ paths when logical is declared in extras map', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    // A staged file under the declared logical must pass without throwing.
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/PLAN.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects shared/extras/<logical>/ paths when logical is not in extras map', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // `bar` is not in extras, so the runtime allowed array has no entry for
    // it. The classifier surfaces the existing `to sync ...` FATAL.
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() => enforceAllowList('A  shared/extras/bar/.planning/PLAN.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync shared/extras/bar/.planning/PLAN.md'),
    );
  });

  it('legacy path-map.json without extras key produces no extras allow-list entries', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Absence of the `extras` key (D-03 additive contract) means no
    // `shared/extras/` prefixes are generated; any such path is rejected.
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/PLAN.md\0', map)).toThrow(
      NomadFatal,
    );
  });

  it('rejects non-whitelisted dirnames under a declared extras logical', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Declaring `foo: ['.planning']` only widens the allow-list for the
    // whitelisted dirname; manually staged content under `random-dir` (or any
    // name outside `SUPPORTED_EXTRAS`) must still surface as FATAL so the
    // dirname whitelist is enforced at the staging boundary, not just inside
    // `remapExtrasPush`.
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/random-dir/FILE.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync shared/extras/foo/random-dir/FILE.md'),
    );
  });

  it('drops non-whitelisted dirnames from the allow-list even when declared in path-map.json', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // If `path-map.json` declares a dirname outside `SUPPORTED_EXTRAS`,
    // `remapExtrasPush` skips it with a log line, so it never reaches the
    // staged tree on a clean run. The allow-list filters by the same
    // whitelist so a manually staged copy is still blocked.
    const map: PathMap = { projects: {}, extras: { foo: ['.scratch'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/.scratch/note.md\0', map)).toThrow(
      NomadFatal,
    );
  });
});

// isNeverSync scope fix: paths under `shared/extras/` are exempt from the
// `NEVER_SYNC` segment scan because the segment list was authored against
// `~/.claude/` semantics for ephemeral Claude Code state. `.planning/todos/`
// inside the extras tree is a meaningful GSD path; blocking it would corrupt
// the sync. The early-return narrows scope to non-extras paths only; the
// regression guard below proves the original surface still blocks.
describe('isNeverSync: extras scope', () => {
  it('returns false for shared/extras/<logical>/.planning/todos/... paths (Pitfall 6 fix)', async () => {
    // Re-import via a small wrapper because isNeverSync is not exported.
    // The acceptance signal is end-to-end via enforceAllowList: a path that
    // would otherwise hit the `todos` segment hard-block must pass when it
    // lives under `shared/extras/`.
    const { enforceAllowList } = await import('./commands.push.ts');
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/todos/2026-05-22-task.md\0', map),
    ).not.toThrow();
  });

  it('still hard-blocks NEVER_SYNC segments outside shared/extras/ (regression guard)', async () => {
    const { enforceAllowList } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    // A path NOT prefixed with `shared/extras/` that contains a NEVER_SYNC
    // segment must still trigger the hard-block. This proves the early-return
    // narrows scope rather than removing the guard wholesale.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/projects/foo/todos/file.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('shared/projects/foo/todos/file.md is in NEVER_SYNC'),
    );
    vi.restoreAllMocks();
  });
});

// cmdPush integration: the new `remapExtrasPush` call lands between
// `remapPush` and `findGitlinks` so the produced `shared/extras/...` paths
// are visible to the allow-list classification on the resulting `git
// status`. The integration mocks the remap functions so the test does not
// depend on host disk state and proves the call site fires before the
// gitlink walk runs.
describe('cmdPush: extras pipeline integration', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-cmdpush-extras-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
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
    vi.doUnmock('./push-checks.ts');
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
    vi.doUnmock('node:child_process');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('calls remapExtrasPush after remapPush and before the gitlink walk', async () => {
    // Track the relative order of remapPush, remapExtrasPush, findGitlinks.
    // The plan's required order: remapPush -> remapExtrasPush -> findGitlinks.
    const callOrder: string[] = [];
    const remapPushMock = vi.fn(() => {
      callOrder.push('remapPush');
      return { unmapped: 0, collisions: 0 };
    });
    const remapExtrasPushMock = vi.fn(() => {
      callOrder.push('remapExtrasPush');
      return { unmapped: 0, skipped: 0 };
    });
    const findGitlinksMock = vi.fn(() => {
      callOrder.push('findGitlinks');
      return [];
    });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
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
    const remapExtrasPushMock = vi.fn(() => ({ unmapped: 0, skipped: 0 }));
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
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
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0 })),
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

  it('combines remapResult.unmapped + extrasResult.unmapped in the post-push success summary', async () => {
    // Regression pin for the 3-site emitSummary contract: the post-commit
    // success path historically only passed remapResult.unmapped, silently
    // dropping TBD-host extras from the user-visible WARN. With 2 session
    // unmapped + 3 extras unmapped, the combined "5 unmapped on push" must
    // appear in the WARN summary line.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: {} }) + '\n',
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
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 2, collisions: 0 })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 3, skipped: 0 })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const errSpyLocal = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const logSpyLocal = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    // push complete log line confirms we reached the success path (not the
    // empty-status or dry-run branches whose own coverage exists elsewhere).
    expect(logSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n')).toContain(
      'push complete',
    );
    const combined = errSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('5 unmapped on push');
  });

  it('surfaces extrasResult.skipped to emitSummary on the clean push success path', async () => {
    // skipped=2 from remapExtrasPush should produce the new
    // "2 extras skipped" suffix on the push WARN line.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { foo: ['node_modules', '.planning'] } }) + '\n',
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
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0 })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 0, skipped: 2 })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    // Hoist a single console.error spy so the test asserts against the WARN
    // glyph routed through warn() -> console.error.
    const errSpyLocal = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    const combined = errSpyLocal.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(combined).toContain('2 extras skipped');
  });
});

// Regression for issue #111: a fresh host whose entire `shared/extras/`
// subtree is untracked. Git's default porcelain collapses an all-untracked
// subtree to a single `?? shared/extras/` parent record, which the child
// prefix allow-list (`shared/extras/<logical>/<dirname>/`) rejects. The
// push path must read with `untrackedAll: true` so per-file extras paths
// surface and the existing allow-list matches. Uses a REAL git repo so the
// collapse behavior is exercised end-to-end, not faked through a literal.
describe('issue #111: untracked extras subtree porcelain collapse', () => {
  let repo: string;

  beforeEach(() => {
    // Defend against a leaked `node:child_process` doMock from an earlier
    // test in this file: the dynamically-imported gitStatusPorcelainZ would
    // otherwise bind to a mock returning empty Buffers and the real-git
    // assertions would see no status output. Unmock + reset so a fresh,
    // unmocked utils.ts loads.
    vi.doUnmock('node:child_process');
    vi.resetModules();
    repo = mkdtempSync(join(tmpdir(), 'nomad-111-'));
    runGit(repo, ['init', '-q']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    // shared/ is tracked (committed); only the new extras subtree is untracked.
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'CLAUDE.md'), '# shared\n');
    runGit(repo, ['add', 'shared/CLAUDE.md']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    // Untracked extras: a multi-file subtree under a project's logical name.
    const planning = join(repo, 'shared', 'extras', 'myproj', '.planning');
    mkdirSync(join(planning, 'todos'), { recursive: true });
    writeFileSync(join(planning, 'PLAN.md'), '# plan\n');
    writeFileSync(join(planning, 'todos', 'a.md'), '# todo\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('default porcelain collapses the untracked subtree to a bare parent record', async () => {
    const { gitStatusPorcelainZ } = await import('./utils.ts');
    const { parsePorcelainZ } = await import('./commands.push.ts');
    const paths = parsePorcelainZ(gitStatusPorcelainZ(repo));
    // The collapse: a single `shared/extras/` directory record, no per-file paths.
    expect(paths).toContain('shared/extras/');
    expect(paths).not.toContain('shared/extras/myproj/.planning/PLAN.md');
  });

  it('untrackedAll porcelain expands the subtree to per-file paths the allow-list accepts', async () => {
    const { gitStatusPorcelainZ } = await import('./utils.ts');
    const { parsePorcelainZ, enforceAllowList } = await import('./commands.push.ts');
    const status = gitStatusPorcelainZ(repo, { untrackedAll: true });
    const paths = parsePorcelainZ(status);
    // Per-file expansion, not the collapsed parent.
    expect(paths).toContain('shared/extras/myproj/.planning/PLAN.md');
    expect(paths).toContain('shared/extras/myproj/.planning/todos/a.md');
    expect(paths).not.toContain('shared/extras/');
    // The runtime allow-list child prefix now matches every per-file path.
    const map: PathMap = { projects: {}, extras: { myproj: ['.planning'] } };
    expect(() => enforceAllowList(status, map)).not.toThrow();
  });
});
