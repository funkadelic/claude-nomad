import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  joinedLog,
  makeUpdateEnv,
  mockDoctor,
  mockGit,
  PRIVATE_SSH,
  PUBLIC_SSH,
  restoreEnv,
  type Env,
} from './commands.update.test-helpers.ts';

describe('cmdUpdate dry-run', () => {
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
});
