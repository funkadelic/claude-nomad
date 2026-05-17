import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

// FMT-05 harness, inline per file (RESEARCH.md A8: extraction deferred).
type LogSpy = MockInstance<(...args: unknown[]) => void>;
type ErrorSpy = MockInstance<(...args: unknown[]) => void>;
type ExitSpy = MockInstance<(code?: string | number | null) => never>;

type Env = {
  testHome: string;
  logSpy: LogSpy;
  errorSpy: ErrorSpy;
  exitSpy: ExitSpy;
};

function makeEnv(host: string): Env {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-test-resume-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = host;
  mkdirSync(join(testHome, 'claude-nomad'), { recursive: true });
  mkdirSync(join(testHome, '.claude', 'projects'), { recursive: true });
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    // Capture only; assertions inspect call list.
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
    // Capture only.
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${String(code)}`);
  });
  return { testHome, logSpy, errorSpy, exitSpy };
}

function writeTranscript(testHome: string, encodedDir: string, sessionId: string, lines: string[]): void {
  const dir = join(testHome, '.claude', 'projects', encodedDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function writePathMap(testHome: string, projects: Record<string, Record<string, string>>): void {
  writeFileSync(
    join(testHome, 'claude-nomad', 'path-map.json'),
    JSON.stringify({ projects }) + '\n',
  );
}

describe('resumeCmd', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (env !== undefined) rmSync(env.testHome, { recursive: true, force: true });
  });

  it('prints the exact cd-and-resume line on happy path', async () => {
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-tmp-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot', fileName: 'foo' }),
      JSON.stringify({
        type: 'user',
        cwd: '/orig/host/foo',
        sessionId: 'abc-123',
        version: '2.1.101',
      }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': '/tmp/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('abc-123');
    expect(env.logSpy).toHaveBeenCalledTimes(1);
    // WR-06: localPath and sessionId are single-quoted so spaces and shell
    // metachars survive `eval`.
    expect(env.logSpy).toHaveBeenCalledWith(`cd '/tmp/foo' && claude --resume 'abc-123'`);
    expect(env.exitSpy).not.toHaveBeenCalled();
  });

  it('FATALs and exits 1 when session is not found in any encoded dir', async () => {
    env = makeEnv('test-host');
    writePathMap(env.testHome, {});
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('nonexistent-id')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'FATAL: session nonexistent-id not found in any ~/.claude/projects/<encoded>/',
      ),
    );
  });

  it('FATALs when recorded cwd is not present in path-map.json', async () => {
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-strange-encoded', 'orphan-1', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/strange/path/not/in/map' }),
    ]);
    writePathMap(env.testHome, {
      other: { 'test-host': '/tmp/other' },
    });
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('orphan-1')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('/strange/path/not/in/map'),
    );
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('not found in path-map.json'),
    );
  });

  it('FATALs with the exact "not mapped on this host" message when current-host mapping is TBD', async () => {
    env = makeEnv('unconfigured-host');
    writeTranscript(env.testHome, '-orig-host-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'unconfigured-host': 'TBD' },
    });
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('abc-123')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'session abc-123 not mapped on this host; add the logical to path-map.json',
      ),
    );
  });

  it('reads cwd from the FIRST non-file-history-snapshot line, skipping line 1', async () => {
    env = makeEnv('test-host');
    // Line 1 is file-history-snapshot (no cwd); line 2 has the cwd; line 3 has
    // a DIFFERENT cwd, so resumeCmd must pick line 2's value, proving it stops
    // at the first match rather than scanning to the last or scanning line 1.
    writeTranscript(env.testHome, '-some-encoded', 'first-match-id', [
      JSON.stringify({ type: 'file-history-snapshot', fileName: 'noise' }),
      JSON.stringify({ type: 'user', cwd: '/correct/path' }),
      JSON.stringify({ type: 'user', cwd: '/wrong/later/path' }),
    ]);
    writePathMap(env.testHome, {
      correct: { 'orig-host': '/correct/path', 'test-host': '/local/mapped/correct' },
      wrong: { 'orig-host': '/wrong/later/path', 'test-host': '/local/mapped/wrong' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('first-match-id');
    expect(env.logSpy).toHaveBeenCalledWith(
      `cd '/local/mapped/correct' && claude --resume 'first-match-id'`,
    );
  });

  // WR-06 regression: spaces in localPath must survive `eval` so cd lands at
  // the intended dir (and not "cd" with three args dropping into /local/mapped).
  it('shell-quotes localPath with spaces so eval works', async () => {
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-orig-host-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': '/local/path with spaces/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('abc-123');
    expect(env.logSpy).toHaveBeenCalledWith(
      `cd '/local/path with spaces/foo' && claude --resume 'abc-123'`,
    );
  });

  // WR-06 regression: single quotes in either argument get escaped via the
  // POSIX '\'' pattern (close quote, escaped quote, reopen quote).
  it('escapes single quotes in localPath using the POSIX close-escape-reopen pattern', async () => {
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-orig-host-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': "/local/it's/foo" },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('abc-123');
    expect(env.logSpy).toHaveBeenCalledWith(
      `cd '/local/it'\\''s/foo' && claude --resume 'abc-123'`,
    );
  });
});
