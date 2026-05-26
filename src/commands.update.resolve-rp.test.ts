import { rmSync } from 'node:fs';
import type * as fsModule from 'node:fs';

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

describe('cmdUpdate auto-resolve (release-please artifact set)', () => {
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

  it('fork merge fails with release-please artifact set, prompt y: auto-resolves and continues', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths:
        'package.json\npackage-lock.json\nCHANGELOG.md\n.release-please-manifest.json\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const promptSpy = vi.fn(() => 'y');
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: promptSpy });
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).toContain('git checkout --theirs -- package.json');
    expect(argvs).toContain('git checkout --theirs -- package-lock.json');
    expect(argvs).toContain('git checkout --theirs -- CHANGELOG.md');
    expect(argvs).toContain('git checkout --theirs -- .release-please-manifest.json');
    expect(argvs).toContain('npm install');
    expect(argvs).toContain('git commit --no-edit');
    expect(doctor.spy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalled();
    expect(joinedLog(env.logSpy)).toContain('auto-resolved');
  });

  it('fork merge fails with release-please artifact subset (no CHANGELOG), prompt y: auto-resolves', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package.json\npackage-lock.json\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    cmdUpdate({ prompt: () => 'y' });
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).toContain('git checkout --theirs -- package.json');
    expect(argvs).toContain('git checkout --theirs -- package-lock.json');
    expect(argvs).not.toContain('git checkout --theirs -- CHANGELOG.md');
    expect(doctor.spy).toHaveBeenCalledTimes(1);
  });

  it('fork merge fails with release-please artifacts, prompt n: declines and propagates NomadFatal', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package.json\npackage-lock.json\nCHANGELOG.md\n',
    });
    const doctor = mockDoctor();
    vi.resetModules();
    const promptSpy = vi.fn(() => 'n');
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate({ prompt: promptSpy });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git merge upstream/main');
    expect(promptSpy).toHaveBeenCalled();
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).not.toContain('git checkout --theirs -- package.json');
    expect(doctor.spy).not.toHaveBeenCalled();
  });

  it('fork merge fails with release-please artifacts and no prompt opt: defaultPrompt declines, propagates', async () => {
    // No `prompt` passed: defaultPrompt's /dev/tty open is mocked to throw,
    // so the prompt returns '' and the y/N check treats it as no. Exercises
    // the `opts.prompt ?? defaultPrompt` fallback deterministically (without
    // this mock the test would hang on interactive local Vitest runs where
    // /dev/tty actually opens).
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      unmergedPaths: 'package.json\npackage-lock.json\n',
    });
    const doctor = mockDoctor();
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
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      cmdUpdate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).not.toContain('git checkout --theirs -- package.json');
    expect(doctor.spy).not.toHaveBeenCalled();
  });

  it('fork merge fails and unmerged-path probe also throws: original merge NomadFatal propagates', async () => {
    const git = mockGit({
      remotes: { origin: PRIVATE_SSH, upstream: PUBLIC_SSH },
      mergeThrows: Object.assign(new Error('CONFLICT'), { stderr: Buffer.from('CONFLICT') }),
      diffThrows: new Error('git diff exploded'),
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
    expect((caught as Error).message).toContain('git merge upstream/main');
    const argvs = git.calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(argvs).not.toContain('git checkout --theirs -- package-lock.json');
    expect(doctor.spy).not.toHaveBeenCalled();
  });
});
