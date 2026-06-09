import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdUpdate, readInstalledVersion } from './commands.update.ts';
import { NomadFatal } from './utils.ts';

/**
 * Build a fake SpawnSyncFn that dispatches on the first argument element.
 * Calls with args[0] === '--version' return `versionResult` (or throw if it is
 * an Error). All other calls (the npm update) are recorded and return ''.
 */
function makeFakeRun(versionResult: string | Error): {
  run: (bin: string, args: readonly string[]) => string;
  calls: { bin: string; args: readonly string[] }[];
} {
  const calls: { bin: string; args: readonly string[] }[] = [];
  const run = (bin: string, args: readonly string[]): string => {
    calls.push({ bin, args });
    if (args[0] === '--version') {
      if (versionResult instanceof Error) throw versionResult;
      return versionResult;
    }
    return '';
  };
  return { run, calls };
}

describe('cmdUpdate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints status line, runs npm update, then reports the new version', () => {
    const logSpy = vi.spyOn(console, 'log');
    const { run, calls } = makeFakeRun('0.47.1\n');

    cmdUpdate(run);

    // Two subprocess calls: npm update then nomad --version
    expect(calls).toHaveLength(2);
    expect(calls[0].bin).toBe('npm');
    expect(calls[0].args).toEqual(['update', '-g', 'claude-nomad']);
    expect(calls[1].bin).toBe('nomad');
    expect(calls[1].args).toEqual(['--version']);

    // Status line before update
    expect(logSpy.mock.calls[0][0]).toContain('Updating claude-nomad');
    // Success line with trimmed semver prefixed with v
    expect(logSpy.mock.calls[1][0]).toContain('now at v0.47.1');
  });

  it('prints fallback line when version query fails, does not throw', () => {
    const logSpy = vi.spyOn(console, 'log');
    const { run } = makeFakeRun(new Error('spawn failed'));

    expect(() => cmdUpdate(run)).not.toThrow();

    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('Updating claude-nomad'))).toBe(true);
    expect(lines.some((l) => l.includes('nomad --version'))).toBe(true);
  });

  it('throws NomadFatal when npm is not on PATH (ENOENT)', () => {
    const run = () => {
      const err = new Error('spawn npm ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };

    expect(() => cmdUpdate(run)).toThrow(NomadFatal);
    expect(() => cmdUpdate(run)).toThrow('npm not found on PATH');
  });

  it('throws NomadFatal on non-zero npm exit', () => {
    const run = () => {
      throw new Error('npm exited with code 1');
    };

    expect(() => cmdUpdate(run)).toThrow(NomadFatal);
    expect(() => cmdUpdate(run)).toThrow('npm update -g claude-nomad failed');
  });
});

describe('readInstalledVersion', () => {
  it('returns trimmed version string on success', () => {
    const run = (_bin: string, _args: readonly string[]) => '0.47.1\n';
    expect(readInstalledVersion(run)).toBe('0.47.1');
  });

  it('returns null when the run throws', () => {
    const run = () => {
      throw new Error('spawn failed');
    };
    expect(readInstalledVersion(run)).toBeNull();
  });

  it('returns null when the output is empty or whitespace only', () => {
    const run = (_bin: string, _args: readonly string[]) => '   \n';
    expect(readInstalledVersion(run)).toBeNull();
  });
});
