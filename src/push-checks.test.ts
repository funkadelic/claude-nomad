import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as osModule from 'node:os';

describe('findGitlinks (hand-rolled symlink-safe walker)', () => {
  let originalHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testDir = mkdtempSync(join(tmpdir(), 'nomad-push-checks-walker-'));
    process.env.HOME = testDir;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns an empty array for a clean directory with no .git entries', async () => {
    const { findGitlinks } = await import('./push-checks.ts');
    expect(findGitlinks(testDir)).toEqual([]);
  });

  it('finds a nested .git directory (real nested repo)', async () => {
    const { findGitlinks } = await import('./push-checks.ts');
    const nestedGit = join(testDir, 'foo', '.git');
    mkdirSync(nestedGit, { recursive: true });
    writeFileSync(join(nestedGit, 'HEAD'), 'ref: refs/heads/main');
    const hits = findGitlinks(testDir);
    expect(hits).toContain(nestedGit);
    expect(hits.length).toBe(1);
  });

  it('finds a .git file (submodule gitlink pointer)', async () => {
    const { findGitlinks } = await import('./push-checks.ts');
    const subDir = join(testDir, 'sub');
    mkdirSync(subDir);
    const gitlinkFile = join(subDir, '.git');
    writeFileSync(gitlinkFile, 'gitdir: ../.git/modules/sub');
    const hits = findGitlinks(testDir);
    expect(hits).toContain(gitlinkFile);
    expect(hits.length).toBe(1);
  });

  it('returns empty for a self-referential symlink cycle (load-bearing: recursive readdirSync follows cycles)', async () => {
    const { findGitlinks } = await import('./push-checks.ts');
    // Build a cycle: testDir/cycle -> testDir. With { recursive: true } this
    // would yield ~82 entries before libuv's internal cap; the hand-rolled
    // walker must short-circuit at the symlink and return [].
    symlinkSync(testDir, join(testDir, 'cycle'));
    expect(findGitlinks(testDir)).toEqual([]);
  });

  it('collects multiple .git hits under different subdirs', async () => {
    const { findGitlinks } = await import('./push-checks.ts');
    mkdirSync(join(testDir, 'a', '.git'), { recursive: true });
    mkdirSync(join(testDir, 'b', 'nested'), { recursive: true });
    writeFileSync(join(testDir, 'b', 'nested', '.git'), 'gitdir: ../../.git/modules/b');
    const hits = findGitlinks(testDir);
    expect(hits.length).toBe(2);
    expect(hits).toContain(join(testDir, 'a', '.git'));
    expect(hits).toContain(join(testDir, 'b', 'nested', '.git'));
  });

  it('silently skips a subdirectory whose readdirSync throws EACCES', async () => {
    // Two real sibling subtrees: `accessible/foo/.git` (a real hit) plus
    // `locked/` chmodded to 0o000 so readdirSync throws EACCES on entry. The
    // walker's catch (line 90) returns from that subtree without rethrowing
    // and keeps the hit from `accessible/`. Cleanup chmods locked back to
    // 0o700 before rmSync, otherwise teardown fails on EACCES.
    const { findGitlinks } = await import('./push-checks.ts');
    const accessibleGit = join(testDir, 'accessible', 'foo', '.git');
    mkdirSync(accessibleGit, { recursive: true });
    writeFileSync(join(accessibleGit, 'HEAD'), 'ref: refs/heads/main');
    const lockedDir = join(testDir, 'locked');
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(join(lockedDir, '.git'), 'gitdir: would-be-hit-but-unreadable-parent');
    chmodSync(lockedDir, 0o000);
    try {
      const hits = findGitlinks(testDir);
      // The accessible hit survives; the locked subtree contributes nothing
      // because readdirSync threw before the loop could enumerate its entries.
      expect(hits).toContain(accessibleGit);
      // The locked dir's .git entry is NOT reported (subtree's readdir failed
      // before it could enumerate the .git file).
      expect(hits.some((p) => p.startsWith(lockedDir))).toBe(false);
    } finally {
      // Restore perms so rmSync in afterEach can descend.
      chmodSync(lockedDir, 0o700);
    }
  });
});

describe('probeGitleaks / rebaseBeforePush (mocked child_process)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let stderrSpy: MockInstance<(...args: unknown[]) => boolean>;
  let stdoutSpy: MockInstance<(...args: unknown[]) => boolean>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-push-checks-mock-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
    // Spy on process.stderr.write so the stderr-forwarding behavior in
    // rebaseBeforePush can be asserted via call history.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  // probeGitleaks
  it('probeGitleaks throws NomadFatal with install hint on ENOENT', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('spawn gitleaks ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    const { probeGitleaks } = await import('./push-checks.ts');
    expect(() => probeGitleaks()).toThrow(/gitleaks not on PATH/);
    expect(() => probeGitleaks()).toThrow(/Install:/);
    const { NomadFatal } = await import('./utils.ts');
    try {
      probeGitleaks();
    } catch (err) {
      expect(err).toBeInstanceOf(NomadFatal);
    }
  });

  it('probeGitleaks returns trimmed version string on success', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('v8.18.2\n')),
      };
    });
    const { probeGitleaks } = await import('./push-checks.ts');
    expect(probeGitleaks()).toBe('v8.18.2');
  });

  it('probeGitleaks passes --config when REPO_HOME/.gitleaks.toml exists', async () => {
    // Cover the truthy branch of `if (existsSync(tomlPath))` in probeGitleaks.
    // Place a minimal .gitleaks.toml at REPO_HOME (resolves to
    // <testHome>/claude-nomad via process.env.HOME and config.ts) and capture
    // the args passed to gitleaks; the --config flag plus the toml path must
    // be present alongside the `version` subcommand.
    const repoHome = join(testHome, 'claude-nomad');
    mkdirSync(repoHome, { recursive: true });
    writeFileSync(join(repoHome, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    let capturedArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          capturedArgs = args ?? [];
          return Buffer.from('v8.30.1\n');
        }),
      };
    });
    const { probeGitleaks } = await import('./push-checks.ts');
    expect(probeGitleaks()).toBe('v8.30.1');
    expect(capturedArgs).toContain('--config');
    expect(capturedArgs).toContain(join(repoHome, '.gitleaks.toml'));
  });

  it('probeGitleaks throws NomadFatal with "gitleaks --version failed" on non-ENOENT errors', async () => {
    // Distinguish line 119 from the ENOENT branch (line 118). EACCES means
    // the binary exists but the spawn was denied; the message MUST be the
    // explicit "gitleaks --version failed: <reason>" form, not the install
    // hint. This guarantees diagnosability when a sandbox or policy denies
    // execution rather than the binary being absent.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }),
      };
    });
    const { probeGitleaks } = await import('./push-checks.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => probeGitleaks()).toThrow(NomadFatal);
    expect(() => probeGitleaks()).toThrow(/gitleaks --version failed/);
    expect(() => probeGitleaks()).toThrow(/permission denied/);
    // Negation: must NOT show the install hint (that branch is ENOENT only).
    try {
      probeGitleaks();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Install:/);
    }
  });

  it('rebaseBeforePush throws without forwarding stderr when the error carries no stderr buffer', async () => {
    // Cover the line-180 falsey branch (`if (e.stderr)` false). git fails
    // with no captured stderr (e.g., signal-killed before output). The
    // FATAL fires with the standard rebase message and no spurious stderr
    // forwarding lands.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          // Throw an error with NO .stderr property.
          throw new Error('git terminated');
        }),
      };
    });
    const { rebaseBeforePush } = await import('./push-checks.ts');
    const stderrCallCountBefore = stderrSpy.mock.calls.length;
    expect(() => rebaseBeforePush()).toThrow(/rebase failed/);
    // The FATAL message itself does not go through process.stderr.write
    // (it lives on the thrown NomadFatal). No forwarding should have run.
    const stderrCallsAfter = stderrSpy.mock.calls.slice(stderrCallCountBefore);
    const forwarded = stderrCallsAfter.some((c: unknown[]) => {
      const chunk = c[0];
      return (
        (Buffer.isBuffer(chunk) && chunk.toString().length > 0) ||
        (typeof chunk === 'string' && chunk.length > 0)
      );
    });
    expect(forwarded).toBe(false);
  });

  // rebaseBeforePush
  it('rebaseBeforePush does not throw on clean rebase', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { rebaseBeforePush } = await import('./push-checks.ts');
    expect(() => rebaseBeforePush()).not.toThrow();
    // Ensure stdoutSpy is referenced (lint-clean) without changing behavior.
    expect(stdoutSpy).toBeDefined();
  });

  it('rebaseBeforePush throws NomadFatal with corrected wording on conflict and forwards stderr', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('Command failed') as NodeJS.ErrnoException & {
            stderr?: Buffer;
          };
          err.stderr = Buffer.from('CONFLICT (content): Merge conflict in foo');
          throw err;
        }),
      };
    });
    const { rebaseBeforePush } = await import('./push-checks.ts');
    expect(() => rebaseBeforePush()).toThrow(/rebase failed/);
    expect(() => rebaseBeforePush()).toThrow(/git rebase --continue/);
    // Negation: corrected wording must NOT reference the stash list.
    try {
      rebaseBeforePush();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/stash/);
    }
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0]);
    const matched = calls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('CONFLICT')) ||
        (typeof chunk === 'string' && chunk.includes('CONFLICT')),
    );
    expect(matched).toBe(true);
  });
});

// gitleaksInstallHint() composes a platform-aware multi-line scaffold that
// mirrors the install.sh onboarding message. The function reads platform(),
// homedir(), process.arch, and process.env.PATH at call time, so each test
// here mocks node:os and saves/restores the process fields it touches.
describe('gitleaksInstallHint (platform-aware install scaffold)', () => {
  let originalArch: NodeJS.Architecture;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalArch = process.arch;
    originalPath = process.env.PATH;
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
    if (originalPath !== undefined) process.env.PATH = originalPath;
    else delete process.env.PATH;
    vi.doUnmock('node:os');
  });

  /** Swap `node:os`'s platform() and homedir() for fixed test values. */
  function mockOs(plat: NodeJS.Platform, home: string): void {
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof osModule>();
      return { ...actual, platform: () => plat, homedir: () => home };
    });
  }

  /** Set process.arch in a way TS-strict mode tolerates. */
  function setArch(value: string): void {
    Object.defineProperty(process, 'arch', { value, configurable: true });
  }

  it('macOS returns the brew one-liner and no Linux scaffold', async () => {
    mockOs('darwin', '/Users/test');
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toMatch(/gitleaks not on PATH/);
    expect(out).toContain('brew install gitleaks');
    expect(out).not.toMatch(/mkdir -p ~\/\.local\/bin/);
  });

  it('Linux + mapped arch (x64) names the linux_x64 tarball', async () => {
    mockOs('linux', '/home/test');
    setArch('x64');
    process.env.PATH = '/home/test/.local/bin:/usr/bin';
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toContain('linux_x64 tarball');
    expect(out).toContain('mkdir -p ~/.local/bin');
  });

  it('Linux + unmapped arch falls back to generic "arch=<x>" wording', async () => {
    mockOs('linux', '/home/test');
    setArch('mips');
    process.env.PATH = '/home/test/.local/bin:/usr/bin';
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toContain('arch=mips');
    expect(out).not.toMatch(/linux_mips tarball/);
  });

  it('Linux + ~/.local/bin missing from PATH adds the PATH-fix step', async () => {
    mockOs('linux', '/home/test');
    setArch('x64');
    process.env.PATH = '/usr/local/bin:/usr/bin'; // no ~/.local/bin
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toMatch(/~\/\.local\/bin is not on PATH/);
    expect(out).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('Linux + ~/.local/bin already on PATH omits the PATH-fix step', async () => {
    mockOs('linux', '/home/test');
    setArch('x64');
    process.env.PATH = '/home/test/.local/bin:/usr/bin';
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).not.toMatch(/~\/\.local\/bin is not on PATH/);
  });

  it('Linux + PATH unset entirely falls through the `?? ""` fallback and still emits the PATH-fix step', async () => {
    // Cover the line-53 `??` fallback branch: when PATH is undefined the
    // split runs on the empty string, paths.includes(localBin) returns
    // false, and the PATH-fix step is appended. Mirrors the "missing from
    // PATH" test but with PATH entirely absent rather than set to a value
    // that lacks ~/.local/bin.
    mockOs('linux', '/home/test');
    setArch('x64');
    delete process.env.PATH;
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toMatch(/~\/\.local\/bin is not on PATH/);
    expect(out).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('Unsupported platform returns just the releases link', async () => {
    mockOs('win32', 'C:/Users/test');
    const { gitleaksInstallHint } = await import('./push-checks.ts');
    const out = gitleaksInstallHint();
    expect(out).toMatch(/gitleaks not on PATH/);
    expect(out).toContain('https://github.com/gitleaks/gitleaks/releases');
    expect(out).not.toContain('brew install');
    expect(out).not.toMatch(/mkdir -p ~\/\.local\/bin/);
  });
});
