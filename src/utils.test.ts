import { hostname } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { deepMerge, encodePath } from './utils.ts';

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
