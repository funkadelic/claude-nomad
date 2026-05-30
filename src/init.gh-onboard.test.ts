import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSyncFn } from './gh-actions.ts';

// ---------------------------------------------------------------------------
// Fake subprocess runner helpers
// ---------------------------------------------------------------------------

type RunOpts = {
  /** Remote URL returned by `git remote get-url origin`; throws when undefined. */
  remote?: string;
  /** Outcome for `gh auth status`. */
  auth?: 'ok' | 'not-installed' | 'not-authed' | 'probe-error';
  /** Outcome for `gh repo create` (`exists` simulates a name-already-taken failure). */
  repoCreate?: 'ok' | 'throw' | 'exists';
  /** Owner string returned by `gh api user --jq .login`. */
  owner?: string;
  /** Outcome for `git init`. */
  gitInit?: 'ok' | 'throw';
  /** Outcome for `git remote add`. */
  remoteAdd?: 'ok' | 'throw';
};

/** Dispatch `git` commands from opts. */
function dispatchGit(opts: RunOpts, argv: string[]): Buffer {
  if (argv[0] === 'remote' && argv[1] === 'get-url') {
    if (opts.remote === undefined) {
      throw Object.assign(new Error('no origin'), { code: 128 });
    }
    return Buffer.from(opts.remote + '\n');
  }
  if (argv[0] === 'init') {
    if (opts.gitInit === 'throw') throw new Error('git init failed');
    return Buffer.from('');
  }
  if (argv[0] === 'remote' && argv[1] === 'add') {
    if (opts.remoteAdd === 'throw') throw new Error('remote add failed');
    return Buffer.from('');
  }
  throw new Error(`Unexpected git argv: ${argv.join(' ')}`);
}

/** Dispatch `gh auth status` from opts. */
function dispatchGhAuth(opts: RunOpts): Buffer {
  const a = opts.auth ?? 'ok';
  if (a === 'not-installed') {
    throw Object.assign(new Error('gh not found'), { code: 'ENOENT' });
  }
  if (a === 'not-authed') {
    throw Object.assign(new Error('not authed'), { status: 1, signal: null });
  }
  if (a === 'probe-error') {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', status: null });
  }
  return Buffer.from('');
}

/** Dispatch `gh` commands from opts. */
function dispatchGh(opts: RunOpts, argv: string[]): Buffer {
  if (argv[0] === 'auth') return dispatchGhAuth(opts);
  if (argv[0] === 'repo' && argv[1] === 'create') {
    if (opts.repoCreate === 'throw') throw new Error('repo create failed');
    if (opts.repoCreate === 'exists') {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from('GraphQL: Name already exists on this account (createRepository)'),
      });
    }
    return Buffer.from('');
  }
  if (argv[0] === 'api' && argv[1] === 'user') {
    return Buffer.from((opts.owner ?? 'test-owner') + '\n');
  }
  throw new Error(`Unexpected gh argv: ${argv.join(' ')}`);
}

/** Build a SpawnSyncFn that dispatches on (bin, args) from the opts above. */
function makeRun(opts: RunOpts): SpawnSyncFn {
  return (bin, args) => {
    const argv = Array.from(args);
    if (bin === 'git') return dispatchGit(opts, argv);
    if (bin === 'gh') return dispatchGh(opts, argv);
    throw new Error(`Unexpected subprocess: ${bin} ${argv.join(' ')}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureOriginRepo', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-onboard-'));
    process.env.HOME = testHome;
    // Point REPO_HOME at a fresh temp dir so the module reads it correctly.
    delete process.env.NOMAD_REPO;
    // Create the repo dir so git remote add has a cwd to work with.
    mkdirSync(join(testHome, 'claude-nomad'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Idempotency: existing origin
  // -------------------------------------------------------------------------

  it('returns without any subprocess beyond the probe when origin already exists', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const calls: string[] = [];
    const run: SpawnSyncFn = (bin, args) => {
      const argv = Array.from(args);
      calls.push(`${bin} ${argv.join(' ')}`);
      if (bin === 'git' && argv[0] === 'remote') {
        return Buffer.from('git@github.com:owner/repo.git\n');
      }
      throw new Error(`Unexpected call: ${bin} ${argv.join(' ')}`);
    };
    ensureOriginRepo('my-repo', run);
    // Only the idempotency probe should have fired.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('git remote get-url origin');
  });

  // -------------------------------------------------------------------------
  // Full create flow
  // -------------------------------------------------------------------------

  it('creates a private repo, resolves owner, and wires origin when no origin exists', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const calls: { bin: string; argv: string[] }[] = [];
    const run: SpawnSyncFn = (bin, args) => {
      const argv = Array.from(args);
      calls.push({ bin, argv });
      if (bin === 'git' && argv[1] === 'get-url') {
        throw Object.assign(new Error('no origin'), { code: 128 });
      }
      if (bin === 'gh' && argv[0] === 'auth') return Buffer.from('');
      if (bin === 'gh' && argv[0] === 'repo') return Buffer.from('');
      if (bin === 'gh' && argv[0] === 'api') return Buffer.from('octocat\n');
      if (bin === 'git' && argv[0] === 'init') return Buffer.from('');
      if (bin === 'git' && argv[1] === 'add') return Buffer.from('');
      throw new Error(`Unexpected: ${bin} ${argv.join(' ')}`);
    };
    ensureOriginRepo('my-config', run);
    const bins = calls.map((c) => c.bin);
    expect(bins).toContain('gh');
    expect(bins).toContain('git');
    // gh repo create called with --private
    const repoCreate = calls.find((c) => c.bin === 'gh' && c.argv.includes('create'));
    expect(repoCreate?.argv).toContain('--private');
    expect(repoCreate?.argv).toContain('my-config');
    // REPO_HOME is git-init'd before the remote is added (CR-01): without this
    // `git remote add` would fail on a brand-new directory.
    const initIdx = calls.findIndex((c) => c.bin === 'git' && c.argv[0] === 'init');
    const addIdx = calls.findIndex((c) => c.bin === 'git' && c.argv[1] === 'add');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(addIdx);
    // git remote add uses the resolved owner
    const remoteAdd = calls.find((c) => c.bin === 'git' && c.argv[1] === 'add');
    expect(remoteAdd?.argv[3]).toBe('git@github.com:octocat/my-config.git');
  });

  // -------------------------------------------------------------------------
  // gh-not-installed: FATAL
  // -------------------------------------------------------------------------

  it('throws NomadFatal with install hint when gh is not installed', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'not-installed' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('https://cli.github.com');
    }
  });

  // -------------------------------------------------------------------------
  // gh-not-authed: FATAL
  // -------------------------------------------------------------------------

  it('throws NomadFatal with auth hint when gh is not authenticated', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'not-authed' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('gh auth login');
    }
  });

  // -------------------------------------------------------------------------
  // gh-probe-error: FATAL with a network-oriented message, NOT the misleading
  // "run gh auth login" hint (an authed user on a slow network would be told to
  // re-authenticate). Mirrors the #124 probe-error distinction.
  // -------------------------------------------------------------------------

  it('throws NomadFatal with a network hint (not auth) on gh-probe-error', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'probe-error' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('could not verify gh CLI status');
      expect(msg).not.toContain('gh auth login');
    }
  });

  // -------------------------------------------------------------------------
  // Invalid repo name: FATAL before any subprocess
  // -------------------------------------------------------------------------

  it('throws NomadFatal on an empty name without calling any subprocess', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const calls: string[] = [];
    const run: SpawnSyncFn = (bin) => {
      calls.push(bin);
      return Buffer.from('');
    };
    expect(() => ensureOriginRepo('', run)).toThrow(NomadFatal);
    expect(calls).toHaveLength(0);
  });

  it('throws NomadFatal on a name with a path separator', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({});
    expect(() => ensureOriginRepo('bad/name', run)).toThrow(NomadFatal);
  });

  it('throws NomadFatal on a name that is only spaces', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({});
    expect(() => ensureOriginRepo('   ', run)).toThrow(NomadFatal);
  });

  it('accepts a valid name with hyphens, dots, and underscores', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    // Provide an existing remote so the function exits early after the name passes.
    const run = makeRun({ remote: 'git@github.com:x/y.git' });
    // Should not throw.
    expect(() => ensureOriginRepo('my_repo.config-v2', run)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // gh api user subprocess failure: NomadFatal
  // -------------------------------------------------------------------------

  it('throws NomadFatal when gh api user fails', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run: SpawnSyncFn = (bin, args) => {
      const argv = Array.from(args);
      if (bin === 'git' && argv[0] === 'remote' && argv[1] === 'get-url') {
        throw Object.assign(new Error('no origin'), { code: 128 });
      }
      if (bin === 'gh' && argv[0] === 'auth') return Buffer.from('');
      if (bin === 'gh' && argv[0] === 'repo') return Buffer.from('');
      if (bin === 'git' && argv[0] === 'init') return Buffer.from('');
      if (bin === 'gh' && argv[0] === 'api') throw new Error('api user failed');
      throw new Error(`Unexpected: ${bin} ${argv.join(' ')}`);
    };
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('gh api user failed');
    }
  });

  // -------------------------------------------------------------------------
  // gh repo create "already exists": idempotent, still wires origin (D-09)
  // -------------------------------------------------------------------------

  it('reuses an existing repo and still wires origin when gh repo create reports it exists', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const calls: { bin: string; argv: string[] }[] = [];
    const inner = makeRun({ auth: 'ok', repoCreate: 'exists', owner: 'octocat' });
    const run: SpawnSyncFn = (bin, args) => {
      calls.push({ bin, argv: Array.from(args) });
      return inner(bin, args);
    };
    expect(() => ensureOriginRepo('my-config', run)).not.toThrow();
    const remoteAdd = calls.find((c) => c.bin === 'git' && c.argv[1] === 'add');
    expect(remoteAdd?.argv[3]).toBe('git@github.com:octocat/my-config.git');
  });

  // -------------------------------------------------------------------------
  // gh repo create subprocess failure: NomadFatal
  // -------------------------------------------------------------------------

  it('throws NomadFatal when gh repo create fails', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'ok', repoCreate: 'throw' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('gh repo create failed');
    }
  });

  // -------------------------------------------------------------------------
  // git remote add subprocess failure: NomadFatal
  // -------------------------------------------------------------------------

  it('throws NomadFatal when git remote add fails', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'ok', repoCreate: 'ok', owner: 'octocat', remoteAdd: 'throw' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('git remote add failed');
    }
  });

  // -------------------------------------------------------------------------
  // git init subprocess failure: NomadFatal (CR-01)
  // -------------------------------------------------------------------------

  it('throws NomadFatal when git init fails', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'ok', gitInit: 'throw' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('git init failed');
    }
  });

  // -------------------------------------------------------------------------
  // Empty / null gh login: NomadFatal, no remote wired (CR-02)
  // -------------------------------------------------------------------------

  it('throws NomadFatal and skips git remote add when gh login is empty', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const calls: string[] = [];
    const inner = makeRun({ auth: 'ok', repoCreate: 'ok', owner: '' });
    const run: SpawnSyncFn = (bin, args) => {
      calls.push(`${bin} ${Array.from(args).join(' ')}`);
      return inner(bin, args);
    };
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('empty login');
    }
    expect(calls.some((c) => c.startsWith('git remote add'))).toBe(false);
  });

  it('throws NomadFatal when gh login is the literal "null"', async () => {
    const { ensureOriginRepo } = await import('./init.gh-onboard.ts');
    const { NomadFatal } = await import('./utils.ts');
    const run = makeRun({ auth: 'ok', repoCreate: 'ok', owner: 'null' });
    expect(() => ensureOriginRepo('my-repo', run)).toThrow(NomadFatal);
    try {
      ensureOriginRepo('my-repo', run);
    } catch (err) {
      expect((err as Error).message).toContain('empty login');
    }
  });

  // -------------------------------------------------------------------------
  // DEFAULT_REPO_NAME exported constant
  // -------------------------------------------------------------------------

  it('exports DEFAULT_REPO_NAME as "claude-nomad-config"', async () => {
    const { DEFAULT_REPO_NAME } = await import('./init.gh-onboard.ts');
    expect(DEFAULT_REPO_NAME).toBe('claude-nomad-config');
  });
});
