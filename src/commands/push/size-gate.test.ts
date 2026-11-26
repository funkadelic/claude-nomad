import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../core/exit-codes.ts';
import { NomadFatal } from '../../core/utils.ts';
import { assertStagedUnderCap } from './size-gate.ts';

describe('assertStagedUnderCap', () => {
  let repo: string;

  /** Run git in the fixture repo with a throwaway identity and no signing. */
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

  /** Write `n` bytes at `rel` and stage it. */
  const stage = (rel: string, n: number): void => {
    writeFileSync(join(repo, rel), 'x'.repeat(n));
    git('add', '--', rel);
  };

  /** The thrown error, or a failure when nothing was thrown. */
  const thrown = (cap?: number): NomadFatal => {
    try {
      assertStagedUnderCap(repo, cap);
    } catch (err) {
      return err as NomadFatal;
    }
    throw new Error('expected assertStagedUnderCap to throw');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nomad-size-gate-'));
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('names each over-cap staged file on an unborn HEAD', () => {
    stage('big.jsonl', 64);
    stage('small.jsonl', 4);
    const err = thrown(16);
    expect(err).toBeInstanceOf(NomadFatal);
    expect(err.code).toBe(EXIT.GENERIC_FAILURE);
    expect(err.message).toContain('nothing was committed');
    expect(err.message).toContain('big.jsonl (1 MiB)');
    expect(err.message).not.toContain('small.jsonl');
    expect(err.message).toContain('nomad drop-session <id>');
  });

  it('checks only what changed since HEAD and passes when it is under the cap', () => {
    stage('big.jsonl', 64);
    git('commit', '-q', '-m', 'seed');
    stage('small.jsonl', 4);
    expect(() => assertStagedUnderCap(repo, 16)).not.toThrow();
  });

  it('ignores a staged deletion and a gitlink', () => {
    stage('big.jsonl', 64);
    git('commit', '-q', '-m', 'seed');
    git('rm', '-q', '--cached', 'big.jsonl');
    const head = git('rev-parse', 'HEAD').trim();
    git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    expect(() => assertStagedUnderCap(repo, 16)).not.toThrow();
  });

  it('passes a small file under the default 100 MiB cap', () => {
    stage('small.jsonl', 4);
    expect(() => assertStagedUnderCap(repo)).not.toThrow();
  });

  it('fails closed when a staged blob cannot be read', () => {
    git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost`);
    expect(thrown(16).message).toContain('could not check staged file sizes');
  });

  it('fails closed outside a git repo', () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    expect(thrown(16).message).toContain('could not check staged file sizes');
  });
});
