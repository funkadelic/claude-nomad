import { rmSync } from 'node:fs';

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
    expect(joinedLog(env.logSpy)).toContain('WARN working tree is not clean');
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
});
