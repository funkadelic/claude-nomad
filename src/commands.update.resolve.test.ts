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

describe('cmdUpdate auto-resolve (lockfile and non-lockfile conflicts)', () => {
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

  it('fork merge fails with sole package-lock.json conflict: auto-resolves via --theirs + npm install + commit (only once)', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package-lock.json\n',
      // Production-realistic: after the auto-resolved merge commit, the
      // beforeSha..HEAD diff will include package-lock.json. Asserts that
      // cmdUpdate's trailing reinstallIfNeeded does NOT fire a second
      // npm install on top of the one the auto-resolver already ran.
      diffNames: 'package-lock.json\n',
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
    const npmInstallCalls = git.calls.filter((c) => c.bin === 'npm' && c.args[0] === 'install');
    expect(npmInstallCalls).toHaveLength(1);
    expect(doctor.spy).toHaveBeenCalledTimes(1);
    expect(joinedLog(env.logSpy)).toContain('auto-resolved merge conflict');
    expect(joinedLog(env.logSpy)).toContain('package-lock.json');
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
});
