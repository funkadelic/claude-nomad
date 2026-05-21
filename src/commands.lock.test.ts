import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as childProcessModule from 'node:child_process';
import type * as utilsModule from './utils.ts';

// Regression: cmdPull and cmdPush must release the lockfile even when a
// fatal error fires mid-flight. Earlier code path called process.exit()
// from die(), which skipped the try/finally and left a stale lock holding
// the now-dead PID.
describe('cmdPull / cmdPush lock release on fatal', () => {
  type LogSpy = MockInstance<(...args: unknown[]) => void>;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let lockPath: string;
  let logSpy: LogSpy;
  let errSpy: LogSpy;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-lock-fatal-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(repoUnderHome, { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
    // Suppress noisy fatal output during the test.
    errSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((_chunk) => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  /**
   * Stitch every recorded `console.log` call into a single newline-joined
   * string so assertions can match on substrings or the position of a
   * particular line within the run's full output.
   */
  function logOutput(): string {
    return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  /** Sibling of `logOutput` for `console.error` (warn/fail glyph output). */
  function errOutput(): string {
    return errSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./push-checks.ts');
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('./remap.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('never acquires the lockfile when cmdPull hits the unscaffolded-repo precondition (settings.base.json missing)', async () => {
    // shared/ dir exists but settings.base.json is absent. The unscaffolded-
    // repo precondition in cmdPull fires BEFORE acquireLock and throws NomadFatal,
    // which escapes to the top-level nomad.ts catch (NOT cmdPull's try/catch:
    // the early-precondition lives outside the try block by design so a
    // missing scaffold never creates a lock file). The lock therefore must
    // not exist on disk and cmdPull throws the FATAL upward.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdPull()).toThrow(NomadFatal);
    // The lock file MUST NOT exist: the check fires before acquireLock.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPull dies because the backup parent path is a file (mkdir ENOTDIR)', async () => {
    // Pre-create ~/.cache/claude-nomad/backup as a regular FILE. acquireLock
    // creates the parent dir; freshBackupTs only reads. mkdirSync(backupRoot,
    // recursive: true) then fails with ENOTDIR because it tries to descend
    // into a file. cmdPull's catch turns it into a fatal exit + lock release.
    // Pre-write settings.base.json so the unscaffolded-repo precondition passes and
    // cmdPull reaches the lock+backup section; the test still exercises the
    // post-lock-acquired die path that the existing finally must release.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    const cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'backup'), '');
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPull catches a non-NomadFatal error and rethrows', async () => {
    // Mock applySharedLinks to throw a TypeError (non-NomadFatal). cmdPull's
    // catch should rethrow, but finally still releases the lock.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    vi.doMock('./links.ts', () => ({
      applySharedLinks: vi.fn(() => {
        throw new TypeError('synthetic non-NomadFatal');
      }),
      regenerateSettings: vi.fn(),
    }));
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).toThrow(TypeError);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush rejects a NEVER_SYNC entry via enforceAllowList', async () => {
    // Build a repo state where `git status --porcelain=v1 -z` would emit a
    // NEVER_SYNC path. Stub gitStatusPorcelainZ (the shell-free helper cmdPush
    // routes through) to return the porcelain we want.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? .claude.json\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush dies on missing path-map.json', async () => {
    // Stub probeGitleaks / rebaseBeforePush / remapPush so the pre-checks
    // succeed; gitStatusPorcelainZ returns a non-empty status so the
    // empty-status early return is bypassed; path-map.json absent on disk
    // triggers `die('path-map.json missing...')`. cmdPush's catch sets
    // exitCode and finally releases the lock.
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
    }));
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush dies on malformed path-map.json (parse failure)', async () => {
    // path-map.json present but readJson throws SyntaxError. cmdPush wraps
    // it in NomadFatal; the catch block sets exitCode and finally releases
    // the lock. Mock push-checks/remap so the pre-checks no-op, and mock
    // readJson on utils to deterministically throw.
    writeFileSync(join(repoUnderHome, 'path-map.json'), '{');
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
    }));
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
        readJson: vi.fn(() => {
          throw new SyntaxError('Unexpected end of JSON input');
        }),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lockfile when cmdPush catches a non-NomadFatal error and rethrows', async () => {
    // Mock runGitleaksScan to throw a TypeError (non-NomadFatal). cmdPush's
    // catch rethrows, but finally still releases the lock.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    vi.doMock('./push-checks.ts', () => ({
      findGitlinks: vi.fn(() => []),
      probeGitleaks: vi.fn(() => 'v8.0.0'),
      rebaseBeforePush: vi.fn(),
    }));
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        throw new TypeError('synthetic non-NomadFatal');
      }),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => '?? shared/CLAUDE.md\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).toThrow(TypeError);
    expect(existsSync(lockPath)).toBe(false);
  });

  // The cmdPull unscaffolded-repo precondition fires BEFORE acquireLock,
  // so an unscaffolded REPO_HOME never leaves a lock file behind. Stronger
  // than the post-run `!existsSync(lockPath)` assertion (which also passes
  // when acquireLock + releaseLock both fired): we spy on acquireLock and
  // assert it was NEVER invoked. The early-precondition throws NomadFatal
  // upward (NOT through cmdPull's try/catch which is scoped to the lock-
  // held section), so the top-level nomad.ts catch is what users actually
  // see in production. The check is keyed off shared/settings.base.json
  // (same signal regenerateSettings uses) and surfaces the canonical
  // init-hint phrasing.
  it('throws init-hint NomadFatal and never invokes acquireLock when cmdPull runs against an unscaffolded repo', async () => {
    expect(existsSync(join(repoUnderHome, 'shared', 'settings.base.json'))).toBe(false);
    const acquireSpy = vi.fn(() => null);
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, acquireLock: acquireSpy };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdPull()).toThrow(NomadFatal);
    expect(() => cmdPull()).toThrow("repo not initialized; run 'nomad init'");
    expect(existsSync(lockPath)).toBe(false);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('cmdPull dryRun:true acquires the lock, leaves settings.json byte-identical, and creates no backup dir', async () => {
    // Scaffold a minimally-valid repo so cmdPull reaches the dry-run branch.
    // settings.base.json sets a key that differs from settings.json so the
    // unified diff has something to produce; git pull is stubbed via the
    // child_process mock so the rebase step succeeds without a remote.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const priorSettings = JSON.stringify({ model: 'sonnet' }, null, 2) + '\n';
    writeFileSync(join(testHome, '.claude', 'settings.json'), priorSettings);

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });

    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ dryRun: true });

    // settings.json is byte-identical to its pre-call state.
    expect(readFileSync(join(testHome, '.claude', 'settings.json'), 'utf8')).toBe(priorSettings);
    // Lock was released (we never see it on disk after the finally block).
    expect(existsSync(lockPath)).toBe(false);
    // No backup-root dir exists for any timestamp. Walk the backup parent.
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('cmdPull emits the unmapped-on-pull summary line after pull complete when path-map has unmapped entries', async () => {
    // Two path-map entries with no host mapping for this host (both `'TBD'`).
    // remapPull skips them with `unmapped++` per entry, so the summary line
    // reports `2 unmapped on pull`. The line MUST appear AFTER `pull complete`
    // so users see a deterministic terminator.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(join(repoUnderHome, 'shared', 'projects', 'logical-a'), { recursive: true });
    mkdirSync(join(repoUnderHome, 'shared', 'projects', 'logical-b'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          'logical-a': { 'test-host': 'TBD' },
          'logical-b': { 'other-host': '/other/path' },
        },
      }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    // `pull complete` goes through log() (stdout); the summary is now an
    // unmapped-style warn() (stderr), so check each stream independently.
    // The `summary:` text appears in err only; the body completed marker in log.
    expect(errOutput()).toContain('⚠︎ summary: 2 unmapped on pull (run nomad doctor to list)');
    expect(logOutput()).toContain('pull complete');
  });

  it('cmdPull emits the clean summary line when path-map has no unmapped entries', async () => {
    // Empty path-map means remapPull's loop never runs; unmapped stays 0.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull();
    expect(logOutput()).toMatch(/✓\s+summary: clean/);
  });

  it('cmdPull --dry-run emits the unmapped-on-pull summary line based on computePreview', async () => {
    // Same fixture shape as the real-pull unmapped test, but invoked under
    // dryRun. computePreview returns the same `unmapped` count as remapPull
    // because they share remapPull's dry-run branch internally.
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    mkdirSync(join(repoUnderHome, 'shared', 'projects', 'logical-only'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          'logical-only': { 'test-host': 'TBD' },
        },
      }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    cmdPull({ dryRun: true });
    // `dry-run complete; no mutation` goes through log() (stdout); the
    // summary is now an unmapped-style warn() (stderr), so check each
    // stream independently.
    expect(errOutput()).toContain('⚠︎ summary: 1 unmapped on pull (run nomad doctor to list)');
    expect(logOutput()).toContain('dry-run complete; no mutation');
  });

  it('cmdPull does NOT emit the summary line when a NomadFatal fires mid-flight', async () => {
    // Force `git pull --rebase` to fail. The cmdPull catch block sets exitCode
    // and the finally releases the lock, but the summary line lives INSIDE
    // the try block after `pull complete`, so a fatal mid-flight must NOT
    // reach it (otherwise users would see a misleading `summary: clean` on a
    // FATAL exit).
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      const stderr = Buffer.from('synthetic rebase failure');
      const err = Object.assign(new Error('git pull failed'), { stderr });
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          throw err;
        }),
      };
    });
    const { cmdPull } = await import('./commands.pull.ts');
    expect(() => cmdPull()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(logOutput()).not.toContain('summary:');
  });
});
