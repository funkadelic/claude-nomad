import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitInit, makeCommit } from './test-support/git.ts';
import { gitProbe } from './git-probe.ts';

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

  it('distinguishes a successful silent command from a failed one', () => {
    gitInit(tmp);
    makeCommit(tmp, 'file.txt', 'base\n', 'base');
    // An existence check writes nothing on success, so the empty string and
    // null have to stay different answers.
    expect(gitProbe(['cat-file', '-e', 'HEAD:file.txt'], tmp)).toBe('');
    expect(gitProbe(['cat-file', '-e', 'HEAD:absent.txt'], tmp)).toBeNull();
  });
});
