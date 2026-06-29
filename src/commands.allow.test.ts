import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Sandbox state for tests that need a real REPO_HOME on disk. */
type Env = {
  originalNomadRepo: string | undefined;
  repoHome: string;
};

/**
 * Create a fresh temp directory as a fake REPO_HOME, point NOMAD_REPO at it,
 * and reset the module cache so constants re-evaluate against the new env.
 */
function makeEnv(): Env {
  const originalNomadRepo = process.env.NOMAD_REPO;
  const repoHome = mkdtempSync(join(tmpdir(), 'nomad-allow-test-'));
  process.env.NOMAD_REPO = repoHome;
  vi.resetModules();
  return { originalNomadRepo, repoHome };
}

/**
 * Restore the previous NOMAD_REPO value and clean up the temp directory.
 */
function teardownEnv(env: Env): void {
  vi.restoreAllMocks();
  vi.doUnmock('./commands.allow.ts');
  vi.doUnmock('./commands.redact.core.ts');
  if (env.originalNomadRepo === undefined) {
    delete process.env.NOMAD_REPO;
  } else {
    process.env.NOMAD_REPO = env.originalNomadRepo;
  }
  rmSync(env.repoHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// cmdAllow
// ---------------------------------------------------------------------------

describe('cmdAllow', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    teardownEnv(env);
  });

  it('appends each valid fingerprint via appendGitleaksIgnore', async () => {
    const { cmdAllow } = await import('./commands.allow.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');

    cmdAllow(['a:b:1', 'c:d:2']);

    const content = readFileSync(ignPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain('a:b:1');
    expect(lines).toContain('c:d:2');
    expect(lines).toHaveLength(2);
  });

  it('is idempotent: calling twice with the same fingerprint leaves one line', async () => {
    const { cmdAllow } = await import('./commands.allow.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');

    cmdAllow(['a:b:1']);
    cmdAllow(['a:b:1']);

    const content = readFileSync(ignPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines.filter((l) => l === 'a:b:1')).toHaveLength(1);
  });

  it('exits non-zero and writes nothing for an invalid fingerprint', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });
    const { cmdAllow } = await import('./commands.allow.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');

    expect(() => cmdAllow(['bad\nfingerprint'])).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(ignPath)).toBe(false);

    exitSpy.mockRestore();
  });

  it('dies when REPO_HOME is not cloned', async () => {
    // Point NOMAD_REPO at a path that does not exist.
    const originalNomadRepo = process.env.NOMAD_REPO;
    process.env.NOMAD_REPO = join(tmpdir(), 'nomad-allow-no-repo-' + Date.now());
    vi.resetModules();

    const { cmdAllow } = await import('./commands.allow.ts');
    expect(() => cmdAllow(['a:b:1'])).toThrow();

    if (originalNomadRepo === undefined) {
      delete process.env.NOMAD_REPO;
    } else {
      process.env.NOMAD_REPO = originalNomadRepo;
    }
  });

  it('writes nothing when any fingerprint in the batch is invalid', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });
    const { cmdAllow } = await import('./commands.allow.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');

    // A valid fingerprint precedes an invalid one; the batch validates fully
    // before any write, so a single bad value blocks the entire batch.
    writeFileSync(ignPath, '', 'utf8');

    expect(() => cmdAllow(['a:b:1', 'bad\nvalue', 'c:d:2'])).toThrow('process.exit called');

    const lines = readFileSync(ignPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    // Validate-all-then-write: neither valid value is written when one is bad.
    expect(lines).not.toContain('a:b:1');
    expect(lines).not.toContain('c:d:2');

    exitSpy.mockRestore();
  });
});
