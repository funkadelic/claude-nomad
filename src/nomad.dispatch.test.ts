import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { parseInitArgs, parseRedactArgs } from './nomad.dispatch.ts';

// Dispatcher smoke tests for the `init` and `update` subcommand arms (the
// parseInitArgs / parseRedactArgs paths). Split out of nomad.test.ts to keep
// every file under the line cap. Each test sets process.argv, doMocks the
// relevant command module, stubs process.exit to throw, then dynamically
// imports ./nomad.ts (the unchanged SUT path) to trigger the dispatch. The
// command-module doMock targets are unchanged from the pre-split file.

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

  it('routes bare `nomad update` to cmdUpdate() with the current version', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update'];
    await import('./nomad.ts');
    expect(cmdUpdateMock).toHaveBeenCalledTimes(1);
    expect(cmdUpdateMock).toHaveBeenCalledWith(expect.any(String));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects `nomad update --dry-run` with usage line and exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--dry-run'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad update'));
  });

  it('rejects `nomad update --force` with usage line and exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--force'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad update'));
  });

  it('rejects `nomad update --push-origin` with usage line and exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', '--push-origin'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad update'));
  });

  it('rejects `nomad update bogus` with usage line and exitCode=1', async () => {
    const cmdUpdateMock = vi.fn();
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    process.argv = ['node', 'nomad.ts', 'update', 'bogus'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad update'));
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

  it('routes `nomad init` (bare) to cmdInit with all flags false and no repoName', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: false,
      keepActions: false,
      repoName: undefined,
    });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --snapshot` to cmdInit({ snapshot: true })', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--snapshot'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: true,
      keepActions: false,
      repoName: undefined,
    });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --keep-actions` to cmdInit({ keepActions: true })', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--keep-actions'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: false,
      keepActions: true,
      repoName: undefined,
    });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --snapshot --keep-actions` with both flags', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--snapshot', '--keep-actions'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: true,
      keepActions: true,
      repoName: undefined,
    });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --repo my-config` to cmdInit({ repoName: "my-config" })', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--repo', 'my-config'];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: false,
      keepActions: false,
      repoName: 'my-config',
    });
    expect(cmdInitMock).toHaveBeenCalledTimes(1);
  });

  it('routes `nomad init --snapshot --repo my-config --keep-actions` with all opts', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = [
      'node',
      'nomad.ts',
      'init',
      '--snapshot',
      '--repo',
      'my-config',
      '--keep-actions',
    ];
    await import('./nomad.ts');
    expect(cmdInitMock).toHaveBeenCalledWith({
      snapshot: true,
      keepActions: true,
      repoName: 'my-config',
    });
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

  it('rejects `nomad init --repo --snapshot` (--repo value missing) with usage error', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--repo', '--snapshot'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(cmdInitMock).not.toHaveBeenCalled();
  });

  it('rejects `nomad init --repo` (no value at all) with usage error', async () => {
    const cmdInitMock = vi.fn();
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    process.argv = ['node', 'nomad.ts', 'init', '--repo'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(cmdInitMock).not.toHaveBeenCalled();
  });
});

describe('parseInitArgs', () => {
  /** Build a full process.argv-shaped array for `nomad init <tail>`. */
  function argv(...tail: string[]): string[] {
    return ['node', 'nomad.ts', 'init', ...tail];
  }

  it('bare `nomad init` returns all defaults', () => {
    expect(parseInitArgs(argv())).toStrictEqual({
      snapshot: false,
      keepActions: false,
      repoName: undefined,
    });
  });

  it('--snapshot sets snapshot: true', () => {
    expect(parseInitArgs(argv('--snapshot'))).toStrictEqual({
      snapshot: true,
      keepActions: false,
      repoName: undefined,
    });
  });

  it('--keep-actions sets keepActions: true', () => {
    expect(parseInitArgs(argv('--keep-actions'))).toStrictEqual({
      snapshot: false,
      keepActions: true,
      repoName: undefined,
    });
  });

  it('--repo <name> sets repoName', () => {
    expect(parseInitArgs(argv('--repo', 'my-config'))).toStrictEqual({
      snapshot: false,
      keepActions: false,
      repoName: 'my-config',
    });
  });

  it('all three flags together return all opts set', () => {
    expect(parseInitArgs(argv('--snapshot', '--keep-actions', '--repo', 'x'))).toStrictEqual({
      snapshot: true,
      keepActions: true,
      repoName: 'x',
    });
  });

  it('--repo before boolean flags works', () => {
    expect(parseInitArgs(argv('--repo', 'x', '--snapshot'))).toStrictEqual({
      snapshot: true,
      keepActions: false,
      repoName: 'x',
    });
  });

  it('unknown flag returns null', () => {
    expect(parseInitArgs(argv('--bogus'))).toBeNull();
  });

  it('duplicate --snapshot returns null', () => {
    expect(parseInitArgs(argv('--snapshot', '--snapshot'))).toBeNull();
  });

  it('duplicate --keep-actions returns null', () => {
    expect(parseInitArgs(argv('--keep-actions', '--keep-actions'))).toBeNull();
  });

  it('duplicate --repo returns null', () => {
    expect(parseInitArgs(argv('--repo', 'a', '--repo', 'b'))).toBeNull();
  });

  it('--repo with no value (end of argv) returns null', () => {
    expect(parseInitArgs(argv('--repo'))).toBeNull();
  });

  it('--repo followed by another flag returns null', () => {
    expect(parseInitArgs(argv('--repo', '--snapshot'))).toBeNull();
  });
});

describe('parseRedactArgs', () => {
  /** Build a full process.argv-shaped array for `nomad redact <tail>`. */
  function argv(...tail: string[]): string[] {
    return ['node', 'nomad.ts', 'redact', ...tail];
  }

  it('bare valid id returns { id, rule: undefined, dryRun: false }', () => {
    expect(parseRedactArgs(argv('abc123'))).toStrictEqual({
      id: 'abc123',
      rule: undefined,
      dryRun: false,
    });
  });

  it('id + --dry-run returns dryRun: true', () => {
    expect(parseRedactArgs(argv('abc123', '--dry-run'))).toStrictEqual({
      id: 'abc123',
      rule: undefined,
      dryRun: true,
    });
  });

  it('id + --rule <value> returns rule set', () => {
    expect(parseRedactArgs(argv('abc123', '--rule', 'github-pat'))).toStrictEqual({
      id: 'abc123',
      rule: 'github-pat',
      dryRun: false,
    });
  });

  it('id + --rule + --dry-run (flags after rule) returns both set', () => {
    expect(parseRedactArgs(argv('abc123', '--rule', 'github-pat', '--dry-run'))).toStrictEqual({
      id: 'abc123',
      rule: 'github-pat',
      dryRun: true,
    });
  });

  it('id + --dry-run + --rule (dry-run before rule) returns both set', () => {
    expect(parseRedactArgs(argv('abc123', '--dry-run', '--rule', 'github-pat'))).toStrictEqual({
      id: 'abc123',
      rule: 'github-pat',
      dryRun: true,
    });
  });

  it('--rule with no following value returns null', () => {
    expect(parseRedactArgs(argv('abc123', '--rule'))).toBeNull();
  });

  it('--rule followed by another --flag returns null', () => {
    expect(parseRedactArgs(argv('abc123', '--rule', '--dry-run'))).toBeNull();
  });

  it('unknown trailing flag returns null', () => {
    expect(parseRedactArgs(argv('abc123', '--bogus'))).toBeNull();
  });

  it('missing id (no argv[3]) returns null', () => {
    expect(parseRedactArgs(['node', 'nomad.ts', 'redact'])).toBeNull();
  });

  it('id failing the regex (leading dash) returns null', () => {
    expect(parseRedactArgs(argv('--bad-id'))).toBeNull();
  });

  it('id failing the regex (contains slash) returns null', () => {
    expect(parseRedactArgs(argv('abc/def'))).toBeNull();
  });

  it('duplicate --dry-run returns null', () => {
    expect(parseRedactArgs(argv('abc123', '--dry-run', '--dry-run'))).toBeNull();
  });

  it('duplicate --rule returns null', () => {
    expect(parseRedactArgs(argv('abc123', '--rule', 'x', '--rule', 'y'))).toBeNull();
  });
});
