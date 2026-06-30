import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Smoke tests for the nomad.ts dispatcher. The file is a CLI entry point with
// top-level switch logic, so each test sets process.argv, mocks the cmd
// modules, stubs process.exit, then dynamically imports ./nomad.ts to trigger
// the dispatch. The dispatcher suite is split by subcommand group across
// nomad.test.ts (push + bare help + --version), nomad.dispatch.test.ts
// (init + update arms), and nomad.doctor-drop.test.ts
// (doctor + drop-session). Every file keeps `await import('./nomad.ts')` as
// the SUT path and the command-module doMock targets unchanged.

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
    vi.doUnmock('./commands.drop-session.ts');
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
    expect(cmdPushMock).toHaveBeenCalledWith({
      dryRun: false,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
      fullScan: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad push --dry-run` to cmdPush({ dryRun: true })', async () => {
    const cmdPushMock = vi.fn();
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    process.argv = ['node', 'nomad.ts', 'push', '--dry-run'];
    await import('./nomad.ts');
    expect(cmdPushMock).toHaveBeenCalledTimes(1);
    expect(cmdPushMock).toHaveBeenCalledWith({
      dryRun: true,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
      fullScan: false,
    });
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
    // All seven command modules are mocked so a misdispatch (any case arm
    // accidentally firing on an empty argv) would surface as a non-zero
    // call count, not a silent pass.
    const cmdPullMock = vi.fn();
    const cmdPushMock = vi.fn();
    const cmdDoctorMock = vi.fn();
    const cmdInitMock = vi.fn();
    const cmdDiffMock = vi.fn();
    const cmdUpdateMock = vi.fn();
    const cmdDropSessionMock = vi.fn();
    const resumeCmdMock = vi.fn();
    vi.doMock('./commands.pull.ts', () => ({ cmdPull: cmdPullMock }));
    vi.doMock('./commands.push.ts', () => ({ cmdPush: cmdPushMock }));
    vi.doMock('./commands.doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    vi.doMock('./commands.update.ts', () => ({ cmdUpdate: cmdUpdateMock }));
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
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
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
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
    // The update subcommand must appear in the default help so a cold `nomad`
    // invocation surfaces it. It accepts no flags.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('update'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Update the claude-nomad CLI to the latest npm release'),
    );
    // drop-session is the operator-side recovery half of the gitleaks-on-
    // session-JSONL flow; surface it in DEFAULT_HELP alongside the other
    // subcommands so a cold `nomad` invocation discovers it.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('drop-session'));
    // --version is a global flag (not a subcommand); surface it in DEFAULT_HELP
    // so a cold `nomad` invocation discovers it without consulting the README.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--version'));
  });
});

describe('nomad.ts --version dispatcher', () => {
  // Mirrors the nomad.ts push dispatcher block above: argv-mock +
  // vi.resetModules + exitSpy. Adds a logSpy so the bare-semver assertion can
  // read the captured stdout. No commands.* module needs mocking here because
  // the --version arm reads `pkg.version` synchronously and does not dispatch
  // to a command module.
  let originalHome: string | undefined;
  let originalArgv: string[];
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalArgv = process.argv;
    process.env.HOME = '/tmp';
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured for assertion */
    });
    vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('prints bare semver and exits 0 for `nomad --version`', async () => {
    process.argv = ['node', 'nomad.ts', '--version'];
    await import('./nomad.ts');
    // Assert one of the captured log calls is a single bare-semver string.
    const printed = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(' '));
    const matched = printed.find((line) =>
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(line),
    );
    expect(matched).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects `nomad --version extra-arg` with the canonical usage line and exitCode=1', async () => {
    process.argv = ['node', 'nomad.ts', '--version', 'extra-arg'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad --version'));
  });
});
