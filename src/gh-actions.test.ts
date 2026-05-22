import { describe, expect, it } from 'vitest';

import {
  ghAuthStatus,
  isActionsEnabled,
  isRepoPrivate,
  parseGitHubRemote,
  type SpawnSyncFn,
} from './gh-actions.ts';

// ---------------------------------------------------------------------------
// parseGitHubRemote
// ---------------------------------------------------------------------------

describe('parseGitHubRemote', () => {
  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses SSH URL (git@ form)', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses HTTPS URL with trailing slash (WR-02 regression)', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for a non-GitHub URL', () => {
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it('returns null for a local path', () => {
    expect(parseGitHubRemote('/home/user/myrepo')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseGitHubRemote('')).toBeNull();
  });

  it('trims whitespace before matching', () => {
    expect(parseGitHubRemote('  https://github.com/owner/repo.git  ')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });
});

// ---------------------------------------------------------------------------
// ghAuthStatus
// ---------------------------------------------------------------------------

describe('ghAuthStatus', () => {
  it('returns "gh-not-installed" when the binary is missing (ENOENT)', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => {
      const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      throw err;
    };
    expect(ghAuthStatus(run)).toBe('gh-not-installed');
  });

  it('returns "gh-not-authed" when gh exits non-zero without ENOENT', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => {
      const err = Object.assign(new Error('Command failed'), { code: 1 });
      throw err;
    };
    expect(ghAuthStatus(run)).toBe('gh-not-authed');
  });

  it('returns null when gh auth status exits 0', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => Buffer.from('');
    expect(ghAuthStatus(run)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRepoPrivate
// ---------------------------------------------------------------------------

describe('isRepoPrivate', () => {
  const ref = { owner: 'alice', repo: 'mirror' };

  it('returns true when isPrivate is true', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) =>
      Buffer.from(JSON.stringify({ isPrivate: true }));
    expect(isRepoPrivate(ref, run)).toBe(true);
  });

  it('returns false when isPrivate is false', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) =>
      Buffer.from(JSON.stringify({ isPrivate: false }));
    expect(isRepoPrivate(ref, run)).toBe(false);
  });

  it('throws on invalid JSON output', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => Buffer.from('{not valid');
    expect(() => isRepoPrivate(ref, run)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isActionsEnabled
// ---------------------------------------------------------------------------

describe('isActionsEnabled', () => {
  const ref = { owner: 'alice', repo: 'mirror' };

  it('returns true when output is "true"', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => Buffer.from('true\n');
    expect(isActionsEnabled(ref, run)).toBe(true);
  });

  it('returns false when output is "false"', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => Buffer.from('false\n');
    expect(isActionsEnabled(ref, run)).toBe(false);
  });

  it('returns false for empty output', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => Buffer.from('');
    expect(isActionsEnabled(ref, run)).toBe(false);
  });
});
