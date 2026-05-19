import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Smoke tests for the nomad.ts dispatcher. The file is a CLI entry point with
// top-level switch logic, so each test sets process.argv, mocks the cmd
// modules, stubs process.exit, then dynamically imports ./nomad.ts to trigger
// the dispatch.

describe('nomad.ts push dispatcher', () => {
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
    vi.doUnmock('./commands.push.ts');
    vi.doUnmock('./commands.pull.ts');
    vi.doUnmock('./commands.doctor.ts');
    vi.doUnmock('./diff.ts');
    vi.doUnmock('./init.ts');
    vi.doUnmock('./resume.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad push` to cmdPush() with no opts', async () => {
    const cmdPushMock = vi.fn();
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    process.argv = ['node', 'nomad.ts', 'push'];
    await import('./nomad.ts');
    expect(cmdPushMock).toHaveBeenCalledTimes(1);
    expect(cmdPushMock).toHaveBeenCalledWith();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad push --dry-run` to cmdPush({ dryRun: true })', async () => {
    const cmdPushMock = vi.fn();
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    process.argv = ['node', 'nomad.ts', 'push', '--dry-run'];
    await import('./nomad.ts');
    expect(cmdPushMock).toHaveBeenCalledTimes(1);
    expect(cmdPushMock).toHaveBeenCalledWith({ dryRun: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown argv after `push` with a usage error and exitCode=1', async () => {
    const cmdPushMock = vi.fn();
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    process.argv = ['node', 'nomad.ts', 'push', '--bogus'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdPushMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The user-visible side of the error must include the canonical usage
    // line so a typo at the CLI prints actionable guidance instead of a
    // silent exit. console.error is already spied in beforeEach.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad push'));
  });
});
