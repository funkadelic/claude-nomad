import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deepMerge, encodePath, nowTimestamp } from './utils.ts';

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
