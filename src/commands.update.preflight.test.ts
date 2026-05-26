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

describe('cmdUpdate pre-flight FATALs', () => {
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
});
