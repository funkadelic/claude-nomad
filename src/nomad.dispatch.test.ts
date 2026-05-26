import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Dispatcher smoke tests for the two parseFlags-based subcommand arms
// (`init` and `update`). Split out of nomad.test.ts to keep every file under
// the line cap. Each test sets process.argv, doMocks the relevant command
// module, stubs process.exit to throw, then dynamically imports ./nomad.ts
// (the unchanged SUT path) to trigger the dispatch. The command-module
// doMock targets are unchanged from the pre-split file.

describe('nomad.ts update dispatcher', () => {
  let originalHome: string | undefined;
  let originalArgv: string[];
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalArgv = process.argv;
    process.env.HOME = '/tmp';
    vi.resetModules();
    // process.exit must throw so the script's switch terminates and the test
    // can inspect call history. Throwing also prevents vitest's worker from
    // actually exiting.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.update.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad update` to cmdUpdate({}) with all flags false', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update'];
    await import('./nomad.ts');
    expect(cmdUpdateMock).toHaveBeenCalledTimes(1);
    expect(cmdUpdateMock).toHaveBeenCalledWith({
      dryRun: false,
      force: false,
      pushOrigin: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad update --dry-run --force --push-origin` to cmdUpdate with all flags set', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--dry-run', '--force', '--push-origin'];
    await import('./nomad.ts');
    expect(cmdUpdateMock).toHaveBeenCalledWith({
      dryRun: true,
      force: true,
      pushOrigin: true,
    });
  });

  it('routes `nomad update --force` to cmdUpdate({ force: true, ... })', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--force'];
    await import('./nomad.ts');
    expect(cmdUpdateMock).toHaveBeenCalledWith({
      dryRun: false,
      force: true,
      pushOrigin: false,
    });
  });

  it('rejects `nomad update --bogus` with the canonical usage line and exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--bogus'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad update'));
  });

  it('rejects `nomad update --dry-run --dry-run` (duplicate flag) with exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--dry-run', '--dry-run'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('nomad.ts init dispatcher', () => {
  // Mirrors the push dispatcher block: argv-mock + vi.resetModules + exitSpy.
  // vi.doUnmock('./init.ts') in afterEach is required because vi.restoreAllMocks
  // does not clear vi.doMock module mocks, and the init mock would otherwise
  // leak into other tests in this file.
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
    vi.doUnmock('./init.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad init` (bare) to cmdInit({})', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({ snapshot: false, keepActions: false });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --snapshot` to cmdInit({ snapshot: true })', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--snapshot'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({ snapshot: true, keepActions: false });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --keep-actions` to cmdInit({ keepActions: true })', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--keep-actions'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({ snapshot: false, keepActions: true });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --snapshot --keep-actions` with both flags', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--snapshot', '--keep-actions'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({ snapshot: true, keepActions: true });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('rejects `nomad init --unknown` with usage error and exit 1', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--unknown'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad init'));
    expect(cmdInitMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate `nomad init --snapshot --snapshot` with usage error', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--snapshot', '--snapshot'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(cmdInitMock).not.toHaveBeenCalled();
  });
});
