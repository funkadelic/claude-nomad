import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ProcessExit } from './utils.ts';

// Dispatcher smoke tests for the `doctor` arm and its --check-shared /
// --resume-cmd sub-flags. Split out of nomad.test.ts to keep every file
// under the line cap. Each test sets process.argv, doMocks the relevant
// command module, stubs process.exit to throw, then dynamically imports
// ./nomad.ts (the unchanged SUT path) to trigger the dispatch. The
// command-module doMock targets (commands/doctor/doctor.ts, ./resume.ts) are
// unchanged from the pre-split file.

describe('nomad.ts doctor dispatcher', () => {
  let originalHome: string | undefined;
  let originalArgv: string[];
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalArgv = process.argv;
    process.env.HOME = '/tmp';
    vi.resetModules();
    // A ProcessExit sentinel models real termination: the top-level crash
    // funnel re-throws it untouched, so an expected usage exit never routes
    // through crash handling (no throwaway crash report during the test).
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ProcessExit(code);
    });
    vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands/doctor/doctor.ts');
    vi.doUnmock('./resume.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes bare `nomad doctor` to cmdDoctor with all flags off (compact default)', async () => {
    const cmdDoctorMock = vi.fn();
    vi.doMock('./commands/doctor/doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    process.argv = ['node', 'nomad.ts', 'doctor'];
    await import('./nomad.ts');
    expect(cmdDoctorMock).toHaveBeenCalledTimes(1);
    expect(cmdDoctorMock).toHaveBeenCalledWith({
      checkShared: false,
      checkSchema: false,
      checkRemote: false,
      verbose: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad doctor --check-shared` to cmdDoctor({ checkShared: true })', async () => {
    const cmdDoctorMock = vi.fn();
    vi.doMock('./commands/doctor/doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--check-shared'];
    await import('./nomad.ts');
    expect(cmdDoctorMock).toHaveBeenCalledTimes(1);
    expect(cmdDoctorMock).toHaveBeenCalledWith({
      checkShared: true,
      checkSchema: false,
      checkRemote: false,
      verbose: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes `nomad doctor --verbose` to cmdDoctor({ verbose: true })', async () => {
    const cmdDoctorMock = vi.fn();
    vi.doMock('./commands/doctor/doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--verbose'];
    await import('./nomad.ts');
    expect(cmdDoctorMock).toHaveBeenCalledTimes(1);
    expect(cmdDoctorMock).toHaveBeenCalledWith({
      checkShared: false,
      checkSchema: false,
      checkRemote: false,
      verbose: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects `nomad doctor --check-shared extra` (trailing arg) with exitCode=2', async () => {
    const cmdDoctorMock = vi.fn();
    vi.doMock('./commands/doctor/doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--check-shared', 'extra'];
    const rejected = import('./nomad.ts');
    // Assert the crash-boundary contract: the rejection is the ProcessExit
    // sentinel (not merely something with an `exit:2` message).
    await expect(rejected).rejects.toBeInstanceOf(ProcessExit);
    await expect(rejected).rejects.toThrow('exit:2');
    expect(cmdDoctorMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad doctor'));
  });

  it('routes `nomad doctor --resume-cmd sid-A` to resumeCmd(`sid-A`)', async () => {
    const resumeCmdMock = vi.fn();
    vi.doMock('./resume.ts', () => ({ resumeCmd: resumeCmdMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--resume-cmd', 'sid-A'];
    await import('./nomad.ts');
    expect(resumeCmdMock).toHaveBeenCalledTimes(1);
    expect(resumeCmdMock).toHaveBeenCalledWith('sid-A');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects bare `nomad doctor --resume-cmd` (no id) with the usage line and exitCode=2', async () => {
    const resumeCmdMock = vi.fn();
    vi.doMock('./resume.ts', () => ({ resumeCmd: resumeCmdMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--resume-cmd'];
    const rejected = import('./nomad.ts');
    // Assert the crash-boundary contract: the rejection is the ProcessExit
    // sentinel (not merely something with an `exit:2` message).
    await expect(rejected).rejects.toBeInstanceOf(ProcessExit);
    await expect(rejected).rejects.toThrow('exit:2');
    expect(resumeCmdMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad doctor'));
  });

  it('rejects `nomad doctor --resume-cmd sid-A extra` (trailing arg) with exitCode=2', async () => {
    // The argv-shape guard requires exactly `doctor --resume-cmd <id>`; a
    // trailing positional must surface the usage line, not silently pass the
    // first id through to resumeCmd.
    const resumeCmdMock = vi.fn();
    vi.doMock('./resume.ts', () => ({ resumeCmd: resumeCmdMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--resume-cmd', 'sid-A', 'extra'];
    const rejected = import('./nomad.ts');
    // Assert the crash-boundary contract: the rejection is the ProcessExit
    // sentinel (not merely something with an `exit:2` message).
    await expect(rejected).rejects.toBeInstanceOf(ProcessExit);
    await expect(rejected).rejects.toThrow('exit:2');
    expect(resumeCmdMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad doctor'));
  });

  it('rejects `nomad doctor --bogus` (unknown sub-flag) with the usage line and exitCode=2', async () => {
    const cmdDoctorMock = vi.fn();
    vi.doMock('./commands/doctor/doctor.ts', () => ({ cmdDoctor: cmdDoctorMock }));
    process.argv = ['node', 'nomad.ts', 'doctor', '--bogus'];
    const rejected = import('./nomad.ts');
    // Assert the crash-boundary contract: the rejection is the ProcessExit
    // sentinel (not merely something with an `exit:2` message).
    await expect(rejected).rejects.toBeInstanceOf(ProcessExit);
    await expect(rejected).rejects.toThrow('exit:2');
    expect(cmdDoctorMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('usage: nomad doctor'));
  });
});
