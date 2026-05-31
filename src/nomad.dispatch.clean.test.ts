import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { parseCleanArgs } from './nomad.dispatch.clean.ts';

/**
 * Tests for the `clean` argv parser and the `nomad.ts` clean dispatcher arm.
 * `parseCleanArgs` is exercised directly for every branch (required --backups,
 * value flags, integer guard, mutual exclusion, duplicates, unknown flags).
 * The dispatcher smoke tests set process.argv, doMock ./commands.clean.ts,
 * stub process.exit to throw, then dynamically import ./nomad.ts.
 */

/**
 * Build a full argv array for `nomad clean ...` from the flag tokens.
 *
 * @param flags - Tokens following `clean` (e.g. `['--backups', '--dry-run']`).
 * @returns The complete `['node', 'nomad', 'clean', ...flags]` argv.
 */
function argv(flags: string[]): string[] {
  return ['node', 'nomad', 'clean', ...flags];
}

describe('parseCleanArgs', () => {
  it('parses --backups alone (age default path)', () => {
    expect(parseCleanArgs(argv(['--backups']))).toEqual({
      dryRun: false,
      olderThan: undefined,
      keep: undefined,
    });
  });

  it('parses --backups with --dry-run and --older-than in any order', () => {
    expect(parseCleanArgs(argv(['--older-than', '7d', '--dry-run', '--backups']))).toEqual({
      dryRun: true,
      olderThan: '7d',
      keep: undefined,
    });
  });

  it('parses --keep as a non-negative integer', () => {
    expect(parseCleanArgs(argv(['--backups', '--keep', '3']))).toEqual({
      dryRun: false,
      olderThan: undefined,
      keep: 3,
    });
    expect(parseCleanArgs(argv(['--backups', '--keep', '0']))?.keep).toBe(0);
  });

  it('returns null when --backups is absent', () => {
    expect(parseCleanArgs(argv(['--dry-run']))).toBeNull();
    expect(parseCleanArgs(argv(['--older-than', '14d']))).toBeNull();
  });

  it('returns null when --older-than and --keep are combined', () => {
    expect(parseCleanArgs(argv(['--backups', '--older-than', '14d', '--keep', '3']))).toBeNull();
  });

  it('returns null on an unknown flag', () => {
    expect(parseCleanArgs(argv(['--backups', '--bogus']))).toBeNull();
  });

  it('returns null on a missing value after a value flag', () => {
    expect(parseCleanArgs(argv(['--backups', '--older-than']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--older-than', '--dry-run']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--keep']))).toBeNull();
  });

  it('returns null on a non-integer or negative --keep value', () => {
    expect(parseCleanArgs(argv(['--backups', '--keep', 'two']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--keep', '1.5']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--keep', '-1']))).toBeNull();
  });

  it('returns null on duplicate flags', () => {
    expect(parseCleanArgs(argv(['--backups', '--backups']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--dry-run', '--dry-run']))).toBeNull();
    expect(parseCleanArgs(argv(['--backups', '--keep', '1', '--keep', '2']))).toBeNull();
    expect(
      parseCleanArgs(argv(['--backups', '--older-than', '1d', '--older-than', '2d'])),
    ).toBeNull();
  });
});

describe('nomad.ts clean dispatcher', () => {
  let originalHome: string | undefined;
  let originalArgv: string[];
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalArgv = process.argv;
    process.env.HOME = '/tmp';
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.clean.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad clean --backups --dry-run` to cmdClean in dry-run mode', async () => {
    const cmdCleanMock = vi.fn();
    vi.doMock('./commands.clean.ts', () => ({ cmdClean: cmdCleanMock }));
    process.argv = ['node', 'nomad.ts', 'clean', '--backups', '--dry-run'];
    await import('./nomad.ts');
    expect(cmdCleanMock).toHaveBeenCalledTimes(1);
    expect(cmdCleanMock).toHaveBeenCalledWith({
      dryRun: true,
      olderThan: undefined,
      keep: undefined,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on `nomad clean` without --backups', async () => {
    const cmdCleanMock = vi.fn();
    vi.doMock('./commands.clean.ts', () => ({ cmdClean: cmdCleanMock }));
    process.argv = ['node', 'nomad.ts', 'clean'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdCleanMock).not.toHaveBeenCalled();
  });

  it('exits 1 on `nomad clean --backups --older-than 7d --keep 3`', async () => {
    const cmdCleanMock = vi.fn();
    vi.doMock('./commands.clean.ts', () => ({ cmdClean: cmdCleanMock }));
    process.argv = ['node', 'nomad.ts', 'clean', '--backups', '--older-than', '7d', '--keep', '3'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdCleanMock).not.toHaveBeenCalled();
  });
});
