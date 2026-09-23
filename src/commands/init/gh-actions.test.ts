import { describe, expect, it } from 'vitest';

import { ghAuthStatus, isActionsEnabled, isRepoPrivate, parseGitHubRemote } from './gh-actions.ts';
import type { SpawnSyncFn } from '../../core/spawn-sync.ts';

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

  it('parses HTTPS URL with trailing slash (regression)', () => {
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

  it.each([
    'https://attacker.invalid/github.com/alice/mirror',
    'https://evil.example/github.com/o/r.git',
    'https://github.com.evil.example/o/r',
    'https://github.com@evil.example/o/r',
    'https://notgithub.com/o/r',
    'https://evil.example#@github.com/o/r',
    'https://evil.example?@github.com/o/r',
    'https://evil.example\\@github.com/o/r',
    'evil.example:x@github.com:o/r',
    'github.com/o/r',
    'file://github.com/o/r',
  ])('returns null when github.com is not the host: %s', (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  it.each([
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@github.com:22/owner/repo.git',
    'https://user:token@github.com/owner/repo.git',
    'git://github.com/owner/repo',
    'https://GitHub.com/owner/repo',
    'git+ssh://git@github.com/owner/repo.git',
    'ssh+git://git@github.com/owner/repo.git',
    'https://www.github.com/owner/repo',
    'ssh://git@ssh.github.com:443/owner/repo.git',
    'https://github.com:443/owner/repo',
    'https://github.com/owner/repo.GIT',
    'github.com:owner/repo.git',
  ])('parses a GitHub remote with scheme, userinfo or port: %s', (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it.each([
    'https://github.com/../r',
    'https://github.com/o/r?x=1',
    'https://github.com/o/r#frag',
    'https://github.com/o',
    'https://github.com/o/r/extra',
    'git@github.com:o b/r',
  ])('returns null for a GitHub URL without a plain owner/repo path: %s', (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  it('parses an scp remote with a numeric owner', () => {
    expect(parseGitHubRemote('git@github.com:123/repo.git')).toEqual({
      owner: '123',
      repo: 'repo',
    });
  });

  it('parses a remote with a trailing slash and trailing whitespace', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo/  ')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for a URL the WHATWG parser rejects', () => {
    expect(parseGitHubRemote('https://[bad/owner/repo')).toBeNull();
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
