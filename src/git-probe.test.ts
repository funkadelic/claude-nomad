import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitInit, makeCommit } from './test-support/git.ts';
import { gitProbe, gitTryMutate } from './git-probe.ts';

/**
 * The read-only probe leaf. Runs against real repos (the shared harness drives
 * `execFileSync`), because the property under test is what git actually does
 * with a bad question, not what a stub is told to do.
 */
describe('gitProbe', () => {
  let tmp: string;
  let originalEnv: Record<string, string | undefined>;

  /** Env keys stamped per test and restored afterwards. */
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    tmp = mkdtempSync(join(tmpdir(), 'nomad-git-probe-'));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the command stdout', () => {
    gitInit(tmp);
    makeCommit(tmp, 'file.txt', 'base\n', 'base');
    expect(gitProbe(['ls-files'], tmp)).toBe('file.txt\n');
  });

  it('returns null rather than throwing when git cannot answer', () => {
    // A plain directory: every question about it fails, and a probe that threw
    // would turn a diagnostic into the thing that fails the command.
    expect(gitProbe(['rev-parse', 'HEAD'], tmp)).toBeNull();
  });

  it('returns output larger than the default 1 MB stdout ceiling', () => {
    gitInit(tmp);
    // Node's execFileSync default would throw ENOBUFS here, and the catch below
    // would report it as `null`: a listing probe over a large shared tree would
    // silently read as "git could not answer" and turn its caller's feature off.
    const body = `${'x'.repeat(64)}\n`.repeat(40_000);
    makeCommit(tmp, 'big.txt', body, 'big');
    expect(gitProbe(['cat-file', '-p', 'HEAD:big.txt'], tmp)?.length).toBe(body.length);
  });

  it('distinguishes a successful silent command from a failed one', () => {
    gitInit(tmp);
    makeCommit(tmp, 'file.txt', 'base\n', 'base');
    // An existence check writes nothing on success, so the empty string and
    // null have to stay different answers.
    expect(gitProbe(['cat-file', '-e', 'HEAD:file.txt'], tmp)).toBe('');
    expect(gitProbe(['cat-file', '-e', 'HEAD:absent.txt'], tmp)).toBeNull();
  });
});

/**
 * The mutating-call name. It is the same function, so the point of the cover is
 * that it stays the same function: a future reimplementation that gave it its
 * own body could drift on the timeout, the stdout ceiling, or the
 * never-throwing contract without any call site noticing.
 */
describe('gitTryMutate', () => {
  let tmp: string;
  let originalEnv: Record<string, string | undefined>;

  /** Env keys stamped per test and restored afterwards. */
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    tmp = mkdtempSync(join(tmpdir(), 'nomad-git-try-mutate-'));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is the same implementation as gitProbe', () => {
    expect(gitTryMutate).toBe(gitProbe);
  });

  it('applies a mutation and reports it without throwing', () => {
    gitInit(tmp);
    makeCommit(tmp, 'file.txt', 'committed\n', 'base');
    writeFileSync(join(tmp, 'file.txt'), 'uncommitted edit\n');

    expect(gitTryMutate(['checkout', 'HEAD', '--', 'file.txt'], tmp)).not.toBeNull();
    expect(readFileSync(join(tmp, 'file.txt'), 'utf8')).toBe('committed\n');
  });

  it('returns null rather than throwing when the mutation cannot run', () => {
    // A plain directory: the checkout fails, and the caller has to be able to
    // read that as "the file was left as it was found" instead of dying.
    expect(gitTryMutate(['checkout', 'HEAD', '--', 'file.txt'], tmp)).toBeNull();
  });
});
