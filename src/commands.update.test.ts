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

describe('cmdUpdate vanilla and fork push paths', () => {
  let originalHome: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    env = makeUpdateEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
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

  it('fork topology, no-op merge (HEAD unchanged): skips the push prompt entirely', async () => {
    // Pre- and post-merge HEAD are identical, so the merge brought nothing new
    // and there is nothing to push: no prompt, no `git push` (issue #66).
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: ['1111111111111111111111111111111111111111'],
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const promptSpy = vi.fn(() => 'y');
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: promptSpy });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).toContain('fetch upstream');
    expect(argvs).toContain('merge upstream/main');
    expect(argvs.some((a) => a.startsWith('push'))).toBe(false);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(joinedLog(env.logSpy)).toContain('already in sync with origin/main');
    expect(doctor.spy).toHaveBeenCalledTimes(1);
  });

  it('fork topology, no-op merge with --push-origin: skips the redundant push', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: ['1111111111111111111111111111111111111111'],
    });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ pushOrigin: true });
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs.some((a) => a.startsWith('push'))).toBe(false);
    expect(joinedLog(env.logSpy)).toContain('already in sync with origin/main');
  });

  it('fork topology, no --push-origin: fetches + merges + prompts; n declines push', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
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
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
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
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      headShas: [
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
      ],
    });
    mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: () => 'y' });
    expect(git.calls.map((c) => c.args.join(' '))).toContain('push origin main');
  });
});
