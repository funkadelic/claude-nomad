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
    vi.doUnmock('./commands.update.ts');
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

  it('prints the multi-line default help on bare `nomad` invocation with exitCode=1', async () => {
    // All six command modules are mocked so a misdispatch (any case arm
    // accidentally firing on an empty argv) would surface as a non-zero
    // call count, not a silent pass.
    const cmdPullMock = vi.fn();
    const cmdPushMock = vi.fn();
    const cmdDoctorMock = vi.fn();
    const cmdInitMock = vi.fn();
    const cmdDiffMock = vi.fn();
    const cmdUpdateMock = vi.fn();
    const resumeCmdMock = vi.fn();
    vi.doMock('./commands.pull.ts', () => ({ cmdPull: cmdPullMock }));
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    vi.doMock('./commands.doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    vi.doMock('./init.ts', () => ({ cmdInit: cmdInitMock }));
    vi.doMock('./diff.ts', () => ({ cmdDiff: cmdDiffMock }));
    vi.doMock('./resume.ts', () => ({ resumeCmd: resumeCmdMock }));
    process.argv = ['node', 'nomad.ts'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(cmdPullMock).not.toHaveBeenCalled();
    expect(cmdPushMock).not.toHaveBeenCalled();
    expect(cmdDoctorMock).not.toHaveBeenCalled();
    expect(cmdInitMock).not.toHaveBeenCalled();
    expect(cmdDiffMock).not.toHaveBeenCalled();
    expect(cmdUpdateMock).not.toHaveBeenCalled();
    expect(resumeCmdMock).not.toHaveBeenCalled();
    // The expanded help text is one console.error call carrying a single
    // multi-line string. Assert on three structural anchors (header line,
    // pull --dry-run flag, init --snapshot flag) so future copy edits do
    // not silently drop a section.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad <command> [flags]'),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--dry-run'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--snapshot'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--resume-cmd'));
    // The update subcommand and its flags must appear in the default help so
    // a cold `nomad` invocation surfaces the new command without docs.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('update'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--push-origin'));
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
