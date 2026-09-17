import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { EXIT } from '../core/exit-codes.ts';
import { ProcessExit } from '../core/utils.ts';
import pkg from '../../package.json' with { type: 'json' };
import type * as Bootstrap from './bootstrap.ts';

// The process bootstrap behind the `nomad` binary. `process.exit` is stubbed to
// throw a ProcessExit sentinel so a `never`-typed branch returns to the test
// instead of killing the worker, and crash-report.write.ts is mocked so the
// crash branch writes no file. NomadFatal is imported dynamically because
// handleTopLevelError uses `instanceof` and vi.resetModules() splits realms;
// ProcessExit is not, since it is matched by a registered-symbol brand. The
// async arm of forceTestCrash is deliberately
// uncovered here (see its c8 ignore); src/nomad.crash.test.ts spawns the real
// binary for it.

describe('cli/bootstrap', () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let errSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    // Cleared here, not only in afterEach: either var leaking in from the worker
    // env would otherwise make the no-op test schedule a real crash or rejection.
    delete process.env.NOMAD_TEST_FORCE_CRASH;
    delete process.env.NOMAD_TEST_FORCE_ASYNC_CRASH;
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ProcessExit(code);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../core/config.ts');
    vi.doUnmock('../core/crash-report.write.ts');
    delete process.env.NOMAD_TEST_FORCE_CRASH;
    delete process.env.NOMAD_TEST_FORCE_ASYNC_CRASH;
  });

  /** Import bootstrap with `handleCrash` mocked, returning both for assertions. */
  async function loadWithMockedCrash(): Promise<{
    bootstrap: typeof Bootstrap;
    handleCrash: ReturnType<typeof vi.fn>;
  }> {
    const handleCrash = vi.fn();
    vi.doMock('../core/crash-report.write.ts', () => ({ handleCrash }));
    return { bootstrap: await import('./bootstrap.ts'), handleCrash };
  }

  it('re-throws a ProcessExit sentinel without crash-reporting it', async () => {
    const { bootstrap, handleCrash } = await loadWithMockedCrash();
    const sentinel = new ProcessExit(EXIT.USAGE);
    expect(() => bootstrap.handleTopLevelError(sentinel)).toThrow(sentinel);
    expect(handleCrash).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with a NomadFatal own code and message, writing no crash report', async () => {
    const { bootstrap, handleCrash } = await loadWithMockedCrash();
    const { NomadFatal } = await import('../core/utils.ts');
    const fatal = new NomadFatal('repo is wedged', { code: EXIT.CONFLICT });
    expect(() => bootstrap.handleTopLevelError(fatal)).toThrow(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(EXIT.CONFLICT);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('repo is wedged');
    expect(handleCrash).not.toHaveBeenCalled();
  });

  it('exits quietly on a prompt cancel, writing no crash report', async () => {
    const { bootstrap, handleCrash } = await loadWithMockedCrash();
    const abort = Object.assign(new Error('cancelled'), { name: 'ExitPromptError' });
    expect(() => bootstrap.handleTopLevelError(abort)).toThrow(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(EXIT.INTERRUPTED);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('cancelled.');
    expect(handleCrash).not.toHaveBeenCalled();
  });

  it('crash-reports anything else and exits with the generic failure code', async () => {
    const { bootstrap, handleCrash } = await loadWithMockedCrash();
    const boom = new Error('unexpected');
    expect(() => bootstrap.handleTopLevelError(boom)).toThrow(ProcessExit);
    expect(handleCrash).toHaveBeenCalledTimes(1);
    expect(handleCrash.mock.calls[0][0]).toBe(boom);
    expect(handleCrash.mock.calls[0][2]).toMatchObject({
      platform: process.platform,
      issuesUrl: pkg.bugs.url,
    });
    expect(exitSpy).toHaveBeenCalledWith(EXIT.GENERIC_FAILURE);
  });

  it('routes both async error events through the same funnel', async () => {
    const onSpy = vi.spyOn(process, 'on').mockReturnValue(process);
    const { installTopLevelHandlers, handleTopLevelError } = await import('./bootstrap.ts');
    installTopLevelHandlers();
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', handleTopLevelError);
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', handleTopLevelError);
  });

  it('returns without exiting when the home directory resolves', async () => {
    const { requireHome } = await import('./bootstrap.ts');
    requireHome();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits when the home directory cannot be resolved', async () => {
    vi.doMock('../core/config.ts', () => ({ home: () => '' }));
    const { requireHome } = await import('./bootstrap.ts');
    expect(() => requireHome()).toThrow(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(EXIT.GENERIC_FAILURE);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('could not determine home directory');
  });

  it('does nothing without the test crash env vars', async () => {
    const { forceTestCrash } = await import('./bootstrap.ts');
    expect(() => forceTestCrash()).not.toThrow();
  });

  it('throws on NOMAD_TEST_FORCE_CRASH', async () => {
    process.env.NOMAD_TEST_FORCE_CRASH = '1';
    const { forceTestCrash } = await import('./bootstrap.ts');
    expect(() => forceTestCrash()).toThrow('forced test crash (NOMAD_TEST_FORCE_CRASH)');
  });
});
