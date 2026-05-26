import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeUpdateEnv,
  mockGit,
  PUBLIC_HTTPS,
  PUBLIC_SSH,
  PRIVATE_SSH,
  restoreEnv,
  type Env,
} from './commands.update.test-helpers.ts';

describe('detectTopology', () => {
  it('returns vanilla for a single origin matching the public repo', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PUBLIC_SSH })).toBe('vanilla');
    expect(detectTopology({ origin: PUBLIC_HTTPS })).toBe('vanilla');
    expect(detectTopology({ origin: `${PUBLIC_HTTPS}.git` })).toBe('vanilla');
  });

  it('returns fork when upstream matches the public repo and origin exists', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: PUBLIC_SSH })).toBe('fork');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: PUBLIC_HTTPS })).toBe('fork');
  });

  it('returns unknown when origin does not match and no upstream exists', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH })).toBe('unknown');
    expect(detectTopology({})).toBe('unknown');
  });

  it('returns unknown when upstream is present but does not match the public repo', async () => {
    const { detectTopology } = await import('./update.topology.ts');
    expect(detectTopology({ origin: PRIVATE_SSH, upstream: 'git@github.com:other/repo.git' })).toBe(
      'unknown',
    );
  });

  it('returns unknown when the origin key is enumerable but its value is undefined', async () => {
    // Defensive case: Object.keys returns `origin` because the property was
    // explicitly set (even to undefined). The `origin ?? ''` fallback hands
    // matchesUpstream an empty string, which fails, so the result is unknown.
    const { detectTopology } = await import('./update.topology.ts');
    const remotes: Record<string, string> = {};
    Object.defineProperty(remotes, 'origin', { value: undefined, enumerable: true });
    expect(detectTopology(remotes)).toBe('unknown');
  });
});

describe('loadTopology', () => {
  let originalHome: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    env = makeUpdateEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('wraps `git remote -v` failure in NomadFatal and forwards stderr', async () => {
    const remoteErr = Object.assign(new Error('fatal: not a git repository'), {
      stderr: Buffer.from('fatal: not a git repository'),
    });
    mockGit({ remoteThrows: remoteErr });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    const { loadTopology } = await import('./update.topology.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      loadTopology();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git remote -v failed');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('`git remote -v` failure without stderr buffer: still surfaces NomadFatal cleanly', async () => {
    const remoteErr = new Error('fatal: spawn ENOENT');
    mockGit({ remoteThrows: remoteErr });
    vi.resetModules();
    const { loadTopology } = await import('./update.topology.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: unknown;
    try {
      loadTopology();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as Error).message).toContain('git remote -v failed');
  });
});
