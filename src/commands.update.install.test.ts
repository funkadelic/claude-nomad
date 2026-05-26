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

describe('cmdUpdate install, dirty-force, and network paths', () => {
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
});
