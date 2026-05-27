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

  it('returns "gh-not-authed" when gh runs and exits non-zero (numeric status)', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => {
      // A clean non-zero exit: spawnSync reports the exit code in `status` with
      // no terminating signal. The only definitive unauthenticated signal.
      const err = Object.assign(new Error('Command failed'), { status: 1, signal: null });
      throw err;
    };
    expect(ghAuthStatus(run)).toBe('gh-not-authed');
  });

  it('returns "gh-probe-error" when the probe times out (SIGTERM kill, null status)', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => {
      // A timeout kills the child with SIGTERM, so `status` is null. Auth state
      // is unknown and must not be reported as not-authed.
      const err = Object.assign(new Error('spawnSync gh ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
        status: null,
      });
      throw err;
    };
    expect(ghAuthStatus(run)).toBe('gh-probe-error');
  });

  it('returns "gh-probe-error" for a transient throw with neither ENOENT nor a numeric status', () => {
    const run: SpawnSyncFn = (_bin, _args, _opts) => {
      throw new Error('transient gh failure');
    };
    expect(ghAuthStatus(run)).toBe('gh-probe-error');
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

// ---------------------------------------------------------------------------
// disableActions
// ---------------------------------------------------------------------------

import { disableActions } from './gh-actions.ts';

describe('disableActions', () => {
  const ref = { owner: 'alice', repo: 'mirror' };

  it('calls gh api PUT with the correct args and does not throw on success', () => {
    const calls: string[] = [];
    const run: SpawnSyncFn = (bin, args) => {
      calls.push([bin, ...args].join(' '));
      return Buffer.from('');
    };
    expect(() => disableActions(ref, run)).not.toThrow();
    expect(calls[0]).toContain('repos/alice/mirror/actions/permissions');
    expect(calls[0]).toContain('PUT');
  });

  it('propagates subprocess errors to the caller', () => {
    const run: SpawnSyncFn = () => {
      throw new Error('gh api failed');
    };
    expect(() => disableActions(ref, run)).toThrow('gh api failed');
  });
});
