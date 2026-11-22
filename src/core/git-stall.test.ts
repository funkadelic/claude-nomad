import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installGitStallBounds, SSH_STALL_COMMAND } from './git-stall.ts';

const ISOLATED = ['NOMAD_REPO', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

describe('installGitStallBounds', () => {
  const saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nomad-stall-'));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(dir, 'gitconfig'), '');
    // Keep the machine's own git config out of the probe.
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.NOMAD_REPO = repo;
  });

  afterEach(() => {
    for (const k of ISOLATED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const gitConfig = (key: string, value: string): void => {
    execFileSync('git', ['-C', repo, 'config', key, value]);
  };

  it('bounds HTTPS stalls and ssh stalls when nothing is configured', () => {
    const env: NodeJS.ProcessEnv = {};
    installGitStallBounds(env);
    expect(env).toEqual({
      GIT_HTTP_LOW_SPEED_LIMIT: '1',
      GIT_HTTP_LOW_SPEED_TIME: '120',
      GIT_SSH_COMMAND: SSH_STALL_COMMAND,
    });
  });

  it('keeps env values the user already set', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_HTTP_LOW_SPEED_LIMIT: '5',
      GIT_HTTP_LOW_SPEED_TIME: '600',
      GIT_SSH_COMMAND: 'ssh -i key',
    };
    installGitStallBounds(env);
    expect(env).toEqual({
      GIT_HTTP_LOW_SPEED_LIMIT: '5',
      GIT_HTTP_LOW_SPEED_TIME: '600',
      GIT_SSH_COMMAND: 'ssh -i key',
    });
  });

  it.each([
    ['http.lowSpeedLimit', '0'],
    ['http.lowSpeedTime', '900'],
  ])('leaves HTTPS alone when git config sets %s', (key, value) => {
    gitConfig(key, value);
    const env: NodeJS.ProcessEnv = {};
    installGitStallBounds(env);
    expect(env.GIT_HTTP_LOW_SPEED_LIMIT).toBeUndefined();
    expect(env.GIT_HTTP_LOW_SPEED_TIME).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe(SSH_STALL_COMMAND);
  });

  it.each([
    ['GIT_SSH', () => ({ GIT_SSH: '/usr/bin/plink' })],
    ['GIT_SSH_VARIANT', () => ({ GIT_SSH_VARIANT: 'plink' })],
    ['core.sshCommand', () => (gitConfig('core.sshCommand', 'ssh -i key'), {})],
    ['ssh.variant', () => (gitConfig('ssh.variant', 'plink'), {})],
  ])('leaves ssh alone when %s is set', (_label, setup: () => NodeJS.ProcessEnv) => {
    const env = setup();
    installGitStallBounds(env);
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_HTTP_LOW_SPEED_LIMIT).toBe('1');
  });
});
