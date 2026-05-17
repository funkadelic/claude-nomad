import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deepMerge, encodePath, nowTimestamp, writeJsonAtomic } from './utils.ts';

describe('deepMerge', () => {
  it('overrides scalar values from source', () => {
    const merged = deepMerge({ model: 'sonnet' }, { model: 'opus' });
    expect(merged.model).toBe('opus');
  });

  it('preserves keys only present in target', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { b: 20 });
    expect(merged).toEqual({ a: 1, b: 20 });
  });

  it('recursively merges nested objects', () => {
    const base = { permissions: { allow: ['Bash'], deny: ['Write'] } } as Record<string, unknown>;
    const override = { permissions: { deny: ['Read'] } };
    const merged = deepMerge(base, override);
    expect(merged).toEqual({ permissions: { allow: ['Bash'], deny: ['Read'] } });
  });

  it('replaces arrays rather than concatenating', () => {
    const merged = deepMerge({ allow: ['a', 'b'] }, { allow: ['c'] });
    expect(merged.allow).toEqual(['c']);
  });

  it('treats null source values as overrides', () => {
    const target: Record<string, unknown> = { model: 'sonnet' };
    const merged = deepMerge(target, { model: null });
    expect(merged.model).toBeNull();
  });
});

describe('encodePath', () => {
  it('encodes macOS absolute path', () => {
    expect(encodePath('/Users/norm/code/ha-acwd')).toBe('-Users-norm-code-ha-acwd');
  });

  it('encodes Linux absolute path', () => {
    expect(encodePath('/home/norm/code/ha-acwd')).toBe('-home-norm-code-ha-acwd');
  });

  it('produces different keys for same logical project on different hosts', () => {
    expect(encodePath('/Users/norm/code/foo')).not.toBe(encodePath('/home/norm/code/foo'));
  });
});

describe('HOST resolution', () => {
  const originalNomadHost = process.env.NOMAD_HOST;

  function restoreNomadHost(): void {
    if (originalNomadHost === undefined) {
      delete process.env.NOMAD_HOST;
    } else {
      process.env.NOMAD_HOST = originalNomadHost;
    }
  }

  it('uses NOMAD_HOST when set to a non-empty string', async () => {
    process.env.NOMAD_HOST = 'test-host';
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.HOST).toBe('test-host');
    } finally {
      restoreNomadHost();
    }
  });

  it('falls back to hostname() when NOMAD_HOST is unset', async () => {
    delete process.env.NOMAD_HOST;
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.HOST).toBe(hostname().toLowerCase());
    } finally {
      restoreNomadHost();
    }
  });

  it('falls back to hostname() when NOMAD_HOST is empty string', async () => {
    process.env.NOMAD_HOST = '';
    try {
      vi.resetModules();
      const config = await import('./config.ts');
      expect(config.HOST).toBe(hostname().toLowerCase());
    } finally {
      restoreNomadHost();
    }
  });
});

describe('nowTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats local time as YYYYMMDD-HHMMSS', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 16, 14, 35, 1));
    expect(nowTimestamp()).toBe('20260516-143501');
  });

  it('zero-pads single-digit month, day, hour, minute, second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 3, 7, 9));
    expect(nowTimestamp()).toBe('20260105-030709');
  });
});

describe('backupBeforeWrite', () => {
  let originalHome: string | undefined;
  let testHome: string;
  const ts = '20260516-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies an existing file under CLAUDE_HOME to the backup dir byte-equal', async () => {
    const { backupBeforeWrite } = await import('./utils.ts');
    const src = join(testHome, '.claude', 'settings.json');
    writeFileSync(src, '{"a":1}');
    backupBeforeWrite(src, ts);
    const dst = join(testHome, '.cache', 'claude-nomad', 'backup', ts, 'settings.json');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"a":1}');
  });

  it('is a no-op when the source path does not exist', async () => {
    const { backupBeforeWrite } = await import('./utils.ts');
    const src = join(testHome, '.claude', 'settings.json');
    backupBeforeWrite(src, ts);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  it('refuses paths outside CLAUDE_HOME', async () => {
    const { backupBeforeWrite } = await import('./utils.ts');
    mkdirSync(join(testHome, '.other'), { recursive: true });
    const src = join(testHome, '.other', 'data.json');
    writeFileSync(src, '{"a":1}');
    backupBeforeWrite(src, ts);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  it('recursively copies a directory under CLAUDE_HOME', async () => {
    const { backupBeforeWrite } = await import('./utils.ts');
    const agentsDir = join(testHome, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'foo.md'), 'foo');
    writeFileSync(join(agentsDir, 'bar.md'), 'bar');
    backupBeforeWrite(agentsDir, ts);
    const backupAgents = join(testHome, '.cache', 'claude-nomad', 'backup', ts, 'agents');
    expect(readFileSync(join(backupAgents, 'foo.md'), 'utf8')).toBe('foo');
    expect(readFileSync(join(backupAgents, 'bar.md'), 'utf8')).toBe('bar');
  });
});

describe('writeJsonAtomic', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('writes JSON with two-space indent and trailing newline (writeJson parity)', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeJsonAtomic(target, { model: 'sonnet', hooks: {} });
    const content = readFileSync(target, 'utf8');
    expect(content).toBe(JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n');
  });

  it('leaves no .tmp.<pid> sibling after successful write', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeJsonAtomic(target, { a: 1 });
    const leftover = join(testHome, '.claude', `settings.json.tmp.${process.pid}`);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('replaces an existing file atomically (final destination has new content)', () => {
    const target = join(testHome, '.claude', 'settings.json');
    writeFileSync(target, '{"old":true}\n');
    writeJsonAtomic(target, { fresh: 1 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ fresh: 1 });
  });
});

describe('acquireLock / releaseLock', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let lockPath: string;
  let stderrWrites: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      unlinkSync(lockPath);
    } catch {
      /* defensive cleanup; ignore */
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('fresh acquire creates lockfile with our PID, release removes it', async () => {
    const { acquireLock, releaseLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null and writes stderr skip line when a live PID owns the lock', async () => {
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    const { acquireLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('unlinks stale lockfile and retries when PID file references a dead process', async () => {
    const deadPid = 2147483647;
    let guarded = false;
    try {
      process.kill(deadPid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') guarded = true;
    }
    if (!guarded) {
      throw new Error(
        `PID ${deadPid} unexpectedly live on this host; raise pid_max guard or pick a higher PID.`,
      );
    }
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(lockPath, String(deadPid));
    const { acquireLock, releaseLock } = await import('./utils.ts');
    const handle = acquireLock('pull');
    expect(handle).not.toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns null on double-acquire in the same process (own PID is alive)', async () => {
    const { acquireLock, releaseLock } = await import('./utils.ts');
    const first = acquireLock('pull');
    expect(first).not.toBeNull();
    const second = acquireLock('pull');
    expect(second).toBeNull();
    expect(stderrWrites.join('')).toContain('another nomad pull running, skipping');
    releaseLock(first);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releaseLock(null) is a safe no-op', async () => {
    const { releaseLock } = await import('./utils.ts');
    expect(() => releaseLock(null)).not.toThrow();
    expect(existsSync(join(testHome, '.cache', 'claude-nomad'))).toBe(false);
  });
});
