import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installGitStallBounds, SSH_KEEPALIVE_COMMAND } from './git-stall.ts';

describe('installGitStallBounds', () => {
  const savedRepo = process.env.NOMAD_REPO;
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nomad-stall-'));
    execFileSync('git', ['init', '-q', repo]);
    process.env.NOMAD_REPO = repo;
  });

  afterEach(() => {
    if (savedRepo === undefined) delete process.env.NOMAD_REPO;
    else process.env.NOMAD_REPO = savedRepo;
    rmSync(repo, { recursive: true, force: true });
  });

  it('bounds HTTPS stalls and adds ssh keepalives when nothing is configured', () => {
    const env: NodeJS.ProcessEnv = {};
    installGitStallBounds(env);
    expect(env).toEqual({
      GIT_HTTP_LOW_SPEED_LIMIT: '1000',
      GIT_HTTP_LOW_SPEED_TIME: '60',
      GIT_SSH_COMMAND: SSH_KEEPALIVE_COMMAND,
    });
  });

  it('keeps values the user already set', () => {
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

  it.each([['GIT_SSH'], ['core.sshCommand']])('leaves ssh alone when %s is set', (source) => {
    const env: NodeJS.ProcessEnv = {};
    if (source === 'GIT_SSH') env.GIT_SSH = '/usr/bin/plink';
    else execFileSync('git', ['-C', repo, 'config', 'core.sshCommand', 'ssh -i key']);
    installGitStallBounds(env);
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });
});
