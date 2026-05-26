import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Dispatcher smoke tests for the `drop-session` arm. Split out of
// nomad.test.ts to keep every file under the line cap. Each test sets
// process.argv, doMocks ./commands.drop-session.ts, stubs process.exit to
// throw, then dynamically imports ./nomad.ts (the unchanged SUT path) to
// trigger the dispatch. The command-module doMock target is unchanged from
// the pre-split file.

describe('nomad.ts drop-session dispatcher', () => {
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
    vi.doUnmock('./commands.drop-session.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.argv = originalArgv;
  });

  it('routes `nomad drop-session sid-A` to cmdDropSession(`sid-A`)', async () => {
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', 'sid-A'];
    await import('./nomad.ts');
    expect(cmdDropSessionMock).toHaveBeenCalledTimes(1);
    expect(cmdDropSessionMock).toHaveBeenCalledWith('sid-A');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects bare `nomad drop-session` (no id) with the canonical usage line and exitCode=1', async () => {
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });

  it('rejects `nomad drop-session --bogus` (leading dash where id expected) with exitCode=1', async () => {
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', '--bogus'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });

  it('rejects `nomad drop-session sid-A extra-arg` (two positionals) with exitCode=1', async () => {
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', 'sid-A', 'extra-arg'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });

  it("rejects `nomad drop-session ''` (empty-string id) with exitCode=1", async () => {
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', ''];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });

  it('rejects `nomad drop-session foo/bar` (slash in id) at argv with the usage line', async () => {
    // The earlier argv guard `/^[^-].*/` accepted any non-empty string
    // that did not start with a dash, so `foo/bar` passed argv parsing
    // and only the deeper cmdDropSession validator caught it (with a
    // `FATAL: invalid session id:` message). The tightened argv regex
    // mirrors the function-entry allowlist so the user sees the cleaner
    // `usage: nomad drop-session` line at parse time.
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', 'foo/bar'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });

  it('rejects `nomad drop-session ..` (path traversal in id) at argv with the usage line', async () => {
    // Path traversal was already blocked by the function-entry validator,
    // but the argv guard let it through, muddying the UX (FATAL vs
    // usage:). The tightened argv regex catches it at parse time.
    const cmdDropSessionMock = vi.fn();
    vi.doMock('./commands.drop-session.ts', () => ({ cmdDropSession: cmdDropSessionMock }));
    process.argv = ['node', 'nomad.ts', 'drop-session', '..'];
    await expect(import('./nomad.ts')).rejects.toThrow('exit:1');
    expect(cmdDropSessionMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('usage: nomad drop-session'),
    );
  });
});
