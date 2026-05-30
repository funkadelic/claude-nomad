import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Dispatcher smoke tests for the `adopt` arm. Each test sets process.argv,
// doMocks ./commands.adopt.ts, stubs process.exit to throw, then dynamically
// imports ./nomad.ts (the unchanged SUT path) to trigger the dispatch.

describe('nomad.ts adopt dispatcher', () => {
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
    vi.doUnmock('./commands.adopt.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad adopt foo` to cmdAdopt("foo", { dryRun: false })', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt', 'foo'];
    await import('./nomad.ts');
    expect(cmdAdoptMock).toHaveBeenCalledTimes(1);
    expect(cmdAdoptMock).toHaveBeenCalledWith('foo', { dryRun: false });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad adopt foo --dry-run` to cmdAdopt("foo", { dryRun: true })', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt', 'foo', '--dry-run'];
    await import('./nomad.ts');
    expect(cmdAdoptMock).toHaveBeenCalledTimes(1);
    expect(cmdAdoptMock).toHaveBeenCalledWith('foo', { dryRun: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects bare `nomad adopt` (no name) with the usage line and exitCode=1', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdAdoptMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad adopt <name>'),
    );
  });

  it('rejects `nomad adopt foo bar` (two positionals) with the usage line and exitCode=1', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt', 'foo', 'bar'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdAdoptMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad adopt <name>'),
    );
  });

  it('rejects `nomad adopt --dry-run` (flag before name) with the usage line and exitCode=1', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt', '--dry-run'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdAdoptMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad adopt <name>'),
    );
  });

  it('rejects `nomad adopt foo --bogus` (unknown flag) with the usage line and exitCode=1', async () => {
    const cmdAdoptMock = vi.fn();
    vi.doMock('./commands.adopt.ts', () => ({ cmdAdopt: cmdAdoptMock }));
    process.argv = ['node', 'nomad.ts', 'adopt', 'foo', '--bogus'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdAdoptMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad adopt <name>'),
    );
  });
});
