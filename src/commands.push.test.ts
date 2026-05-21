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
