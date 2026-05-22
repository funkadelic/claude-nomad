import { rmSync } from 'node:fs';
import type * as fsModule from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  joinedLog,
  makeUpdateEnv,
  mockDoctor,
  mockGit,
  PRIVATE_SSH,
  PUBLIC_HTTPS,
  PUBLIC_SSH,
  restoreEnv,
  type Env,
} from './commands.update.test-helpers.ts';

describe('cmdUpdate', () => {
  let originalHome: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    env = makeUpdateEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commands.doctor.ts');
    restoreEnv('HOME', originalHome);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('vanilla topology: runs `git pull --ff-only origin main` and invokes doctor', async () => {
    const git = mockGit({ remotes: { origin: PUBLIC_SSH } });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    const pullCall = git.calls.find((c) => c.bin === 'git' && c.args[0] === 'pull');
    expect(pullCall).toBeDefined();
    expect(pullCall?.args).toEqual(['pull', '--ff-only', 'origin', 'main']);
    expect(git.calls.find((c) => c.bin === 'npm')).toBeUndefined();
    expect(doctor.spy).toHaveBeenCalledTimes(1);
    expect(joinedLog(env.logSpy)).toContain('topology: vanilla');
  });

  it('vanilla topology: HTTPS remote URL is recognized', async () => {
    const git = mockGit({ remotes: { origin: PUBLIC_HTTPS } });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.find((c) => c.bin === 'git' && c.args[0] === 'pull')).toBeDefined();
  });

  it('fork topology, no --push-origin: fetches + merges + prompts; n declines push', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: () => 'n' });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).toContain('fetch upstream');
    expect(argvs).toContain('merge upstream/main');
    expect(argvs.some((a) => a.startsWith('push'))).toBe(false);
    expect(joinedLog(env.logSpy)).toContain('skipping push to origin');
    expect(doctor.spy).toHaveBeenCalledTimes(1);
  });

  it('fork topology with --push-origin: pushes without prompting', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.resetModules();
    const promptSpy = vi.fn(() => 'n');
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ pushOrigin: true, prompt: promptSpy });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).toContain('fetch upstream');
    expect(argvs).toContain('merge upstream/main');
    expect(argvs).toContain('push origin main');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('fork topology, interactive y: pushes to origin', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: () => 'y' });
    expect(git.calls.map((c) => c.args.join(' '))).toContain('push origin main');
  });

  it('fork merge fails with sole package-lock.json conflict: auto-resolves via --theirs + npm install + commit', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package-lock.json\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: () => 'n' });
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).toContain('git merge upstream/main');
    expect(argvs).toContain('git checkout --theirs -- package-lock.json');
    expect(argvs).toContain('git add package-lock.json');
    expect(argvs).toContain('git commit --no-edit');
    expect(argvs).toContain('npm install');
    expect(doctor.spy).toHaveBeenCalledTimes(1);
    expect(joinedLog(env.logSpy)).toContain('auto-resolved package-lock.json conflict');
  });

  it('fork merge fails with multiple conflicts including lockfile: propagates NomadFatal', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package-lock.json\nsrc/foo.ts\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate({ prompt: () => 'n' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).not.toContain('git checkout --theirs -- package-lock.json');
    expect(doctor.spy).not.toHaveBeenCalled();
  });

  it('fork merge fails with sole non-lockfile conflict: propagates NomadFatal', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'src/foo.ts\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate({ prompt: () => 'n' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).not.toContain('git checkout --theirs -- package-lock.json');
    expect(doctor.spy).not.toHaveBeenCalled();
  });

  it('vanilla topology with --push-origin: FATALs (flag is fork-only)', async () => {
    mockGit({ remotes: { origin: PUBLIC_SSH } });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate({ pushOrigin: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('--push-origin');
    expect((caught as Error).message).toContain('fork');
  });

  it('unknown topology bails with FATAL referencing the two-command manual fallback', async () => {
    mockGit({ remotes: {} });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git fetch');
    expect((caught as Error).message).toContain('git merge');
  });

  it('dirty tree refusal: FATALs unless --force is passed', async () => {
    mockGit({ remotes: { origin: PUBLIC_SSH }, status: ' M src/foo.ts\0' });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('working tree is not clean');
  });

  it('dirty tree with --force: WARNs and proceeds with the update flow', async () => {
    const git = mockGit({ remotes: { origin: PUBLIC_SSH }, status: ' M src/foo.ts\0' });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ force: true });
    // warn() routes through console.error (yellow `⚠︎` glyph prefix); allow
    // 1+ spaces between glyph and message to tolerate the WSL alignment pad.
    expect(joinedLog(env.errSpy)).toMatch(/⚠︎ +working tree is not clean/);
    expect(git.calls.find((c) => c.bin === 'git' && c.args[0] === 'pull')).toBeDefined();
  });

  it('lockfile changed: runs `npm install` after the update', async () => {
    const git = mockGit({
      remotes: { origin: PUBLIC_SSH },
      diffNames: 'package-lock.json\nsrc/foo.ts\n',
    });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    const npmCall = git.calls.find((c) => c.bin === 'npm');
    expect(npmCall).toBeDefined();
    expect(npmCall?.args).toEqual(['install']);
  });

  it('lockfile unchanged: skips `npm install` and logs the skip', async () => {
    const git = mockGit({
      remotes: { origin: PUBLIC_SSH },
      diffNames: 'src/foo.ts\nREADME.md\n',
    });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.find((c) => c.bin === 'npm')).toBeUndefined();
    expect(joinedLog(env.logSpy)).toContain('skipping npm install (lockfile unchanged)');
  });

  it('final doctor invocation runs on a non-dry-run happy path', async () => {
    mockGit({ remotes: { origin: PUBLIC_SSH } });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(doctor.spy).toHaveBeenCalledTimes(1);
  });

  it('dry-run: logs would-be commands, skips git mutation, skips doctor', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ dryRun: true });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).toContain('remote -v');
    expect(argvs).not.toContain('fetch upstream');
    expect(argvs).not.toContain('merge upstream/main');
    expect(argvs).not.toContain('pull --ff-only origin main');
    expect(git.calls.find((c) => c.bin === 'npm')).toBeUndefined();
    expect(doctor.spy).not.toHaveBeenCalled();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('DRY-RUN: would run `git fetch upstream`');
    expect(out).toContain('DRY-RUN: would run `git merge upstream/main`');
  });

  it('network failure on fetch: surfaces NomadFatal, skips merge, skips doctor', async () => {
    const networkErr = Object.assign(new Error('fatal: unable to access ...'), {
      stderr: Buffer.from('fatal: unable to access ...'),
    });
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      fetchThrows: networkErr,
    });
    const doctor = mockDoctor();
    // gitOrFatal forwards the captured stderr buffer to process.stderr before
    // throwing NomadFatal. Without this spy the "fatal: unable to access ..."
    // line leaks into vitest's terminal output on every run and could mask
    // real warnings from other tests.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('merge upstream/main');
    expect(doctor.spy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('branch != main: FATALs with a message naming the actual branch', async () => {
    mockGit({ remotes: { origin: PUBLIC_SSH }, branch: 'feat/foo' });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('feat/foo');
    expect((caught as Error).message).toContain('main');
  });

  it('vanilla topology dry-run: logs would-be pull, skips mutation, skips doctor', async () => {
    const git = mockGit({ remotes: { origin: PUBLIC_SSH } });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ dryRun: true });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).not.toContain('pull --ff-only origin main');
    expect(git.calls.find((c) => c.bin === 'npm')).toBeUndefined();
    expect(doctor.spy).not.toHaveBeenCalled();
    expect(joinedLog(env.logSpy)).toContain('DRY-RUN: would run `git pull --ff-only origin main`');
  });

  it('fork dry-run with --push-origin: logs the push command alongside fetch/merge', async () => {
    mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ dryRun: true, pushOrigin: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('DRY-RUN: would run `git fetch upstream`');
    expect(out).toContain('DRY-RUN: would run `git merge upstream/main`');
    expect(out).toContain('DRY-RUN: would run `git push origin main`');
    expect(out).not.toContain('would prompt before pushing');
  });

  it('currentBranch failure: surfaces NomadFatal with the helper-specific message', async () => {
    const branchErr = Object.assign(new Error('fatal: not a git repository'), {
      stderr: Buffer.from('fatal: not a git repository'),
    });
    mockGit({ remotes: { origin: PUBLIC_SSH }, branchThrows: branchErr });
    mockDoctor();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('rev-parse --abbrev-ref HEAD');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('headSha failure: surfaces NomadFatal with the helper-specific message', async () => {
    const headErr = Object.assign(new Error('fatal: bad revision'), {
      stderr: Buffer.from('fatal: bad revision'),
    });
    mockGit({ remotes: { origin: PUBLIC_SSH }, headShaThrows: headErr });
    mockDoctor();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('rev-parse HEAD');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('defaultPrompt: /dev/tty `y\\n` triggers push to origin', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    // Silence the prompt's `process.stdout.write(question)` so the y/N
    // marker does not leak into the test runner's output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Mock node:fs to fake a TTY that yields the bytes "y\n". The mock
    // spreads the original module so existsSync/mkdir* etc. used elsewhere
    // in cmdUpdate (and by makeUpdateEnv) keep their real behavior.
    let bytePos = 0;
    const bytes = Buffer.from('y\n');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        readSync: vi.fn((_fd: number, buf: Buffer) => {
          if (bytePos >= bytes.length) return 0;
          buf[0] = bytes[bytePos++];
          return 1;
        }),
        closeSync: vi.fn(),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).toContain('push origin main');
  });

  it('defaultPrompt: openSync failure returns empty string and skips push', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => {
          throw new Error('ENXIO: no /dev/tty');
        }),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    expect(joinedLog(env.logSpy)).toContain('skipping push to origin');
  });

  it('defaultPrompt: readSync returns 0 on first call yields empty answer', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        // Immediate EOF: the loop's `if (n === 0) break;` arm fires before
        // any bytes are accumulated, so the prompt returns '' and runFork
        // treats it as "no" (skipping the push).
        readSync: vi.fn(() => 0),
        closeSync: vi.fn(),
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    expect(joinedLog(env.logSpy)).toContain('skipping push to origin');
  });

  it('currentBranch failure without stderr buffer: still surfaces NomadFatal cleanly', async () => {
    const branchErr = new Error('fatal: not a git repository');
    mockGit({ remotes: { origin: PUBLIC_SSH }, branchThrows: branchErr });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('rev-parse --abbrev-ref HEAD');
  });

  it('headSha failure without stderr buffer: still surfaces NomadFatal cleanly', async () => {
    const headErr = new Error('fatal: bad revision');
    mockGit({ remotes: { origin: PUBLIC_SSH }, headShaThrows: headErr });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('rev-parse HEAD');
  });

  it('missing REPO_HOME: FATALs with `repo not cloned at ...` before any git call', async () => {
    const git = mockGit({ remotes: { origin: PUBLIC_SSH } });
    mockDoctor();
    // Remove the REPO_HOME directory that makeUpdateEnv created so the
    // existsSync(REPO_HOME) check at the top of cmdUpdate trips.
    rmSync(`${env.testHome}/claude-nomad`, { recursive: true, force: true });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('repo not cloned');
    // No git invocation should have happened — the existsSync gate runs first.
    expect(git.calls).toHaveLength(0);
  });

  it('defaultPrompt: readSync throw is swallowed and returns empty string', async () => {
    const git = mockGit({ remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH } });
    mockDoctor();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const closeSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        openSync: vi.fn(() => 999),
        readSync: vi.fn(() => {
          throw new Error('EIO');
        }),
        closeSync: closeSpy,
      };
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate();
    expect(git.calls.map((c) => c.args.join(' '))).not.toContain('push origin main');
    // Finally arm must run even when readSync throws.
    expect(closeSpy).toHaveBeenCalledWith(999);
  });
});

describe('detectTopology', () => {
  it('returns vanilla for a single origin matching the public repo', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PUBLIC_SSH })).toBe('vanilla');
    expect(detectTopology({ origin: PUBLIC_HTTPS })).toBe('vanilla');
    expect(detectTopology({ origin: `${PUBLIC_HTTPS}.git` })).toBe('vanilla');
  });

  it('returns fork when upstream matches the public repo and origin exists', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: PUBLIC_SSH })).toBe('fork');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: PUBLIC_HTTPS })).toBe('fork');
  });

  it('returns unknown when origin does not match and no upstream exists', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH })).toBe('unknown');
    expect(detectTopology({})).toBe('unknown');
  });

  it('returns unknown when upstream is present but does not match the public repo', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: 'git@github.com:other/repo.git' })).toBe(
      'unknown',
    );
  });

  it('returns unknown when the origin key is enumerable but its value is undefined', async () => {
    // Defensive case: Object.keys returns `origin` because the property was
    // explicitly set (even to undefined). The `origin ?? ''` fallback hands
    // matchesUpstream an empty string, which fails, so the result is unknown.
    const { detectTopology } = await import('./update.topology.ts');
    const remotes: Record<string, string> = {};
    Object.defineProperty(remotes, 'origin', { value: undefined, enumerable: true });
    expect(detectTopology(remotes)).toBe('unknown');
  });
});

describe('loadTopology', () => {
  let originalHome: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    env = makeUpdateEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('wraps `git remote -v` failure in NomadFatal and forwards stderr', async () => {
    const remoteErr = Object.assign(new Error('fatal: not a git repository'), {
      stderr: Buffer.from('fatal: not a git repository'),
    });
    mockGit({ remoteThrows: remoteErr });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    const { loadTopology } = await import('./update.topology.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      loadTopology();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git remote -v failed');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('`git remote -v` failure without stderr buffer: still surfaces NomadFatal cleanly', async () => {
    const remoteErr = new Error('fatal: spawn ENOENT');
    mockGit({ remoteThrows: remoteErr });
    vi.resetModules();
    const { loadTopology } = await import('./update.topology.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      loadTopology();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git remote -v failed');
  });
});
