import { type ExecFileSyncOptions } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdUpdate, readInstalledVersion } from './commands.update.ts';
import { stubPlatform } from './test-helpers.platform.ts';
import { NomadFatal } from './utils.ts';

// The default-platform test below asserts the literal 'npm' bin without
// overriding process.platform, so it is posix-only by construction; the
// win32 branch (npm.cmd) is covered explicitly in the platform-branching
// describe block further down via stubPlatform.
const isWin = process.platform === 'win32';

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

  it.skipIf(isWin)('prints status line, runs npm update, then reports the new version', () => {
    const logSpy = vi.spyOn(console, 'log');
    const { run, calls } = makeFakeRun('0.47.1\n');

    cmdUpdate('0.46.0', run);

    // Two subprocess calls: npm update then nomad --version
    expect(calls).toHaveLength(2);
    expect(calls[0].bin).toBe('npm');
    expect(calls[0].args).toEqual(['update', '-g', 'claude-nomad']);
    expect(calls[1].bin).toBe('nomad');
    expect(calls[1].args).toEqual(['--version']);

    // Status line before update reports the current (old) version
    expect(logSpy.mock.calls[0][0]).toContain('Updating claude-nomad v0.46.0');
    // Success line with trimmed semver prefixed with v
    expect(logSpy.mock.calls[1][0]).toContain('now at v0.47.1');
  });

  it('reports no-op when the installed version already matches the running one', () => {
    const logSpy = vi.spyOn(console, 'log');
    const { run } = makeFakeRun('0.46.0\n');

    cmdUpdate('0.46.0', run);

    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('already at the latest version (v0.46.0)'))).toBe(true);
    expect(lines.some((l) => l.includes('now at'))).toBe(false);
  });

  it('prints fallback line when version query fails, does not throw', () => {
    const logSpy = vi.spyOn(console, 'log');
    const { run } = makeFakeRun(new Error('spawn failed'));

    expect(() => cmdUpdate('0.46.0', run)).not.toThrow();

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

    expect(() => cmdUpdate('0.46.0', run)).toThrow(NomadFatal);
    expect(() => cmdUpdate('0.46.0', run)).toThrow('npm not found on PATH');
  });

  it('throws NomadFatal on non-zero npm exit', () => {
    const run = () => {
      throw new Error('npm exited with code 1');
    };

    expect(() => cmdUpdate('0.46.0', run)).toThrow(NomadFatal);
    expect(() => cmdUpdate('0.46.0', run)).toThrow('npm update -g claude-nomad failed');
  });

  it('folds captured npm stderr into the failure message', () => {
    const run = () => {
      const err = new Error('npm exited with code 1') as NodeJS.ErrnoException & {
        stderr?: string;
      };
      err.stderr = 'npm ERR! code EACCES\nnpm ERR! permission denied';
      throw err;
    };

    expect(() => cmdUpdate('0.46.0', run)).toThrow('npm ERR! permission denied');
  });
});

describe('cmdUpdate platform branching', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  function makeCapturingRun(): {
    run: (bin: string, args: readonly string[], opts?: ExecFileSyncOptions) => string;
    calls: { bin: string; args: readonly string[]; opts?: ExecFileSyncOptions }[];
  } {
    const calls: { bin: string; args: readonly string[]; opts?: ExecFileSyncOptions }[] = [];
    const run = (bin: string, args: readonly string[], opts?: ExecFileSyncOptions): string => {
      calls.push({ bin, args, opts });
      if (args[0] === '--version') return '0.47.1\n';
      return '';
    };
    return { run, calls };
  }

  it('spawns npm.cmd with shell:true and the literal args array on win32', () => {
    stubPlatform('win32');
    const { run, calls } = makeCapturingRun();

    cmdUpdate('0.46.0', run);

    expect(calls[0].bin).toBe('npm.cmd');
    expect(calls[0].args).toEqual(['update', '-g', 'claude-nomad']);
    expect(calls[0].opts?.shell).toBe(true);
    // Existing options preserved alongside the new shell:true.
    expect(calls[0].opts?.encoding).toBe('utf8');
    expect(calls[0].opts?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(calls[0].opts?.maxBuffer).toBe(64 * 1024 * 1024);
  });

  it('spawns npm unchanged (no shell:true) on a non-win32 platform', () => {
    stubPlatform('darwin');
    const { run, calls } = makeCapturingRun();

    cmdUpdate('0.46.0', run);

    expect(calls[0].bin).toBe('npm');
    expect(calls[0].opts?.shell).not.toBe(true);
  });

  it('ENOENT and stderr-fold error paths fire identically on a win32 stub', () => {
    stubPlatform('win32');
    const enoentRun = () => {
      const err = new Error('spawn npm.cmd ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    expect(() => cmdUpdate('0.46.0', enoentRun)).toThrow(NomadFatal);
    expect(() => cmdUpdate('0.46.0', enoentRun)).toThrow('npm not found on PATH');

    const stderrRun = () => {
      const err = new Error('npm exited with code 1') as NodeJS.ErrnoException & {
        stderr?: string;
      };
      err.stderr = 'npm ERR! code EACCES\nnpm ERR! permission denied';
      throw err;
    };
    expect(() => cmdUpdate('0.46.0', stderrRun)).toThrow('npm ERR! permission denied');
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

describe('readInstalledVersion platform branching', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  function makeCapturingRun(): {
    run: (bin: string, args: readonly string[], opts?: ExecFileSyncOptions) => string;
    calls: { bin: string; args: readonly string[]; opts?: ExecFileSyncOptions }[];
  } {
    const calls: { bin: string; args: readonly string[]; opts?: ExecFileSyncOptions }[] = [];
    const run = (bin: string, args: readonly string[], opts?: ExecFileSyncOptions): string => {
      calls.push({ bin, args, opts });
      return '0.47.1\n';
    };
    return { run, calls };
  }

  it('spawns nomad.cmd with shell:true and the literal args array on win32', () => {
    stubPlatform('win32');
    const { run, calls } = makeCapturingRun();

    expect(readInstalledVersion(run)).toBe('0.47.1');

    expect(calls[0].bin).toBe('nomad.cmd');
    expect(calls[0].args).toEqual(['--version']);
    expect(calls[0].opts?.shell).toBe(true);
  });

  it('spawns nomad unchanged (no shell:true) on a non-win32 platform', () => {
    stubPlatform('darwin');
    const { run, calls } = makeCapturingRun();

    expect(readInstalledVersion(run)).toBe('0.47.1');

    expect(calls[0].bin).toBe('nomad');
    expect(calls[0].opts?.shell).not.toBe(true);
  });

  it('returns null on error identically on a win32 stub', () => {
    stubPlatform('win32');
    const run = () => {
      throw new Error('spawn nomad.cmd ENOENT');
    };
    expect(readInstalledVersion(run)).toBeNull();
  });
});
