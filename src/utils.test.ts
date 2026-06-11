import { hostname } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as cpModule from 'node:child_process';

/**
 * Core utils.ts coverage: the symbols that STAY in core after the fs/json/
 * lockfile split (HOST resolution from config, and the git wrapper
 * gitOrFatal). The moved helpers are covered by utils.fs.test.ts,
 * utils.fs.backup.test.ts, utils.json.test.ts, utils.lockfile.test.ts, and
 * utils.lockfile.recovery.test.ts. gitOrFatal/NomadFatal load from ./utils.ts.
 */

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

describe('gitOrFatal (mocked child_process)', () => {
  let stderrSpy: MockInstance<(...args: unknown[]) => boolean>;

  beforeEach(() => {
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  it('returns void when execFileSync succeeds', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { gitOrFatal } = await import('./utils.ts');
    expect(() => gitOrFatal(['pull'], 'git pull', '/tmp')).not.toThrow();
  });

  it('throws NomadFatal with the context message and forwards stderr on failure', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('Command failed') as Error & { stderr?: Buffer };
          err.stderr = Buffer.from('fatal: not a git repository\n');
          throw err;
        }),
      };
    });
    const { gitOrFatal, NomadFatal } = await import('./utils.ts');
    expect(() => gitOrFatal(['status'], 'git status', '/tmp')).toThrow(NomadFatal);
    expect(() => gitOrFatal(['status'], 'git status', '/tmp')).toThrow('git status failed');
    const forwarded = stderrSpy.mock.calls.some(
      (c) => Buffer.isBuffer(c[0]) && c[0].toString().includes('not a git repository'),
    );
    expect(forwarded).toBe(true);
  });

  it('throws NomadFatal without writing to stderr when err.stderr is absent', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          throw new Error('Command failed');
        }),
      };
    });
    const { gitOrFatal, NomadFatal } = await import('./utils.ts');
    expect(() => gitOrFatal(['push'], 'git push', '/tmp')).toThrow(NomadFatal);
    expect(() => gitOrFatal(['push'], 'git push', '/tmp')).toThrow('git push failed');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('item', () => {
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a two-space-indented, glyph-less line for the message', async () => {
    const { item } = await import('./utils.ts');
    item('foo');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = String(logSpy.mock.calls[0][0]);
    expect(out).toContain('  foo');
    expect(out).not.toContain('ℹ︎');
  });
});

describe('gitCaptureRaw (mocked child_process)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  /**
   * Verify gitCaptureRaw returns stdout without trimming (NUL-safe).
   * The critical property: .trim() would corrupt NUL-delimited records
   * from git diff --name-status -z.
   */
  it('returns stdout as-is without trimming (NUL-preserving)', async () => {
    const rawOutput = 'M\0shared/extras/foo/.planning/a.md\0';
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return { ...actual, execFileSync: vi.fn(() => Buffer.from(rawOutput)) };
    });
    const { gitCaptureRaw } = await import('./utils.ts');
    const result = gitCaptureRaw(['diff', '--name-status', '-z', 'HEAD~1', 'HEAD']);
    expect(result).toBe(rawOutput);
  });

  /**
   * Verify cwd is forwarded to execFileSync so git runs in the repo directory.
   */
  it('passes cwd to execFileSync when provided', async () => {
    vi.resetModules();
    let capturedOpts: unknown;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_cmd: unknown, _args: unknown, opts: unknown) => {
          capturedOpts = opts;
          return Buffer.from('');
        }),
      };
    });
    const { gitCaptureRaw } = await import('./utils.ts');
    gitCaptureRaw(['status'], '/repo/path');
    expect((capturedOpts as { cwd?: string }).cwd).toBe('/repo/path');
  });
});
