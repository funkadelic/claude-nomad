import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

describe('cmdDoctor gitlink scan', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits no gitlink FAIL when shared/ has no nested .git entries', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${failGlyph} gitlink`);
    expect(out).toContain('never-sync items:');
  });

  it('emits FAIL gitlink and exitCode=1 for a nested .git directory', async () => {
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'foo', '.git'), { recursive: true });
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'foo', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toContain('gitlink:');
    expect(out).toContain('shared/foo/.git');
    expect(out).toContain('would push as submodule');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('emits FAIL gitlink and exitCode=1 for a .git FILE (submodule gitlink pointer)', async () => {
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'sub'), { recursive: true });
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'sub', '.git'),
      'gitdir: ../.git/modules/sub\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toContain('gitlink:');
    expect(out).toContain('shared/sub/.git');
    expect(out).toContain('would push as submodule');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor rebase clean-tree WARN', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host', setupGitRepo: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits no WARN when REPO_HOME working tree is clean', async () => {
    // makeDoctorEnv writes settings.base.json before git init, so the file
    // appears untracked; commit it (with local identity) to produce a clean
    // tree without disturbing process-global git config.
    const repo = join(env.testHome, 'claude-nomad');
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('has uncommitted changes');
    expect(out).toContain('never-sync items:');
  });

  it('emits WARN line when REPO_HOME has uncommitted changes', async () => {
    writeFileSync(join(env.testHome, 'claude-nomad', 'dirty.txt'), 'not committed\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(warnGlyph);
    expect(out).toContain('~/claude-nomad/');
    expect(out).toContain('has uncommitted changes');
    expect(out).toContain('--autostash');
    expect(out).toContain('never-sync items:');
  });
});
