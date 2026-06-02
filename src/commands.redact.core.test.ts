import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Sandbox state reset for each test that exercises appendGitleaksIgnore. */
type Env = {
  originalNomadRepo: string | undefined;
  repoHome: string;
};

/**
 * Create a fresh temp directory as a fake REPO_HOME, point NOMAD_REPO at it,
 * and reset the module cache so config constants re-evaluate against the new
 * env. Must be called before each test; use `teardownEnv` in afterEach.
 */
function makeEnv(): Env {
  const originalNomadRepo = process.env.NOMAD_REPO;
  const repoHome = mkdtempSync(join(tmpdir(), 'nomad-core-test-'));
  process.env.NOMAD_REPO = repoHome;
  vi.resetModules();
  return { originalNomadRepo, repoHome };
}

/**
 * Restore the previous NOMAD_REPO value and clean up the temp directory.
 */
function teardownEnv(env: Env): void {
  vi.restoreAllMocks();
  vi.doUnmock('./commands.redact.core.ts');
  if (env.originalNomadRepo === undefined) {
    delete process.env.NOMAD_REPO;
  } else {
    process.env.NOMAD_REPO = env.originalNomadRepo;
  }
  rmSync(env.repoHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// isValidFingerprint
// ---------------------------------------------------------------------------

// isValidFingerprint is pure so it does not need the env sandbox.
// Import it at module scope (not inside test) - it is pure and not env-dependent.
import { isValidFingerprint } from './commands.redact.core.ts';

describe('isValidFingerprint', () => {
  it('returns false for empty string', () => {
    expect(isValidFingerprint('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isValidFingerprint('   ')).toBe(false);
  });

  it('returns true for a well-formed file:rule:line fingerprint', () => {
    expect(isValidFingerprint('path/to/file.jsonl:generic-api-key:42')).toBe(true);
  });

  it('returns false when the value contains a newline character', () => {
    expect(isValidFingerprint('path/to/file.jsonl:generic-api-key:42\ninjected')).toBe(false);
  });

  it('returns false when the value contains a carriage return', () => {
    expect(isValidFingerprint('path/to/file.jsonl:generic-api-key:42\rinjected')).toBe(false);
  });

  it('returns true for a long but well-formed fingerprint within the 512-char cap', () => {
    const fp = 'shared/projects/my-long-project-name/session-transcript.jsonl:generic-api-key:9999';
    expect(fp.length).toBeLessThanOrEqual(512);
    expect(isValidFingerprint(fp)).toBe(true);
  });

  it('returns false for an over-length fingerprint (>512 chars)', () => {
    const fp = 'a'.repeat(513);
    expect(isValidFingerprint(fp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendGitleaksIgnore (idempotent behavior)
// ---------------------------------------------------------------------------

describe('appendGitleaksIgnore', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    teardownEnv(env);
  });

  it('creates a new .gitleaksignore with exactly one line when the file is absent', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');
    expect(existsSync(ignPath)).toBe(false);

    append('a:b:1');

    const content = readFileSync(ignPath, 'utf8');
    expect(content).toBe('a:b:1\n');
  });

  it('is idempotent: calling twice yields exactly one matching line', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    append('a:b:1');
    append('a:b:1');

    const content = readFileSync(join(env.repoHome, '.gitleaksignore'), 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines.filter((l) => l === 'a:b:1').length).toBe(1);
  });

  it('appending a distinct fingerprint after an existing one preserves both with no duplicates', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    append('a:b:1');
    append('c:d:2');

    const content = readFileSync(join(env.repoHome, '.gitleaksignore'), 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain('a:b:1');
    expect(lines).toContain('c:d:2');
    expect(lines.length).toBe(2);
  });

  it('is a no-op when the file already contains the fingerprint', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');
    writeFileSync(ignPath, 'a:b:1\n', 'utf8');
    const before = readFileSync(ignPath, 'utf8');

    append('a:b:1');

    expect(readFileSync(ignPath, 'utf8')).toBe(before);
  });

  it('never writes a blank line for an empty fingerprint', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    append('');
    const ignPath = join(env.repoHome, '.gitleaksignore');
    expect(existsSync(ignPath)).toBe(false);
  });

  it('does not fuse onto a file that lacks a trailing newline', async () => {
    const { appendGitleaksIgnore: append } = await import('./commands.redact.core.ts');
    const ignPath = join(env.repoHome, '.gitleaksignore');
    // A hand-edited file with no trailing newline must not fuse the two
    // fingerprints onto one line (which would de-activate both ignore entries).
    writeFileSync(ignPath, 'a:b:1', 'utf8');

    append('c:d:2');

    const content = readFileSync(ignPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['a:b:1', 'c:d:2']);
    expect(content).toBe('a:b:1\nc:d:2\n');
  });
});
