import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeUpdateEnv,
  mockDoctor,
  mockGit,
  PUBLIC_SSH,
  restoreEnv,
  type Env,
} from './commands.update.test-helpers.ts';

describe('cmdUpdate git-wrapper failure surfacing', () => {
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
});
