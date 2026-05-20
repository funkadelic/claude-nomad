import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Spy harness, inline per file (extraction to a shared helper deferred).
type LogSpy = MockInstance<(...args: unknown[]) => void>;
type ErrorSpy = MockInstance<(...args: unknown[]) => void>;
type ExitSpy = MockInstance<(code?: string | number | null) => never>;

type Env = {
  testHome: string;
  logSpy: LogSpy;
  errorSpy: ErrorSpy;
  exitSpy: ExitSpy;
};

/**
 * Build a sandbox env for `resumeCmd` tests: creates a temp `HOME` with
 * `claude-nomad/` and `.claude/projects/` scaffolding, sets `NOMAD_HOST`,
 * resets modules so the test's dynamic import sees the new env, and spies
 * on `console.log` / `console.error` / `process.exit`. Returns the spies
 * plus the temp dir.
 */
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

/**
 * Write a `<sessionId>.jsonl` transcript file under
 * `<testHome>/.claude/projects/<encodedDir>/` with one JSON line per entry
 * in `lines`. Mirrors Claude Code's on-disk session storage layout.
 */
function writeTranscript(
  testHome: string,
  encodedDir: string,
  sessionId: string,
  lines: string[],
): void {
  const dir = join(testHome, '.claude', 'projects', encodedDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

/**
 * Write a `path-map.json` at `<testHome>/claude-nomad/path-map.json` with
 * the given `projects` map (`{ <logical>: { <host>: <abspath> } }`).
 */
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
    // localPath and sessionId are single-quoted so spaces and shell
    // metachars survive `eval`.
    expect(env.logSpy).toHaveBeenCalledWith(`cd '/tmp/foo' && claude --resume 'abc-123'`);
    expect(env.exitSpy).not.toHaveBeenCalled();
  });

  it('rejects sessionId with path-traversal segments before touching the filesystem', async () => {
    env = makeEnv('test-host');
    writePathMap(env.testHome, {});
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('../../etc/passwd')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: invalid session id: ../../etc/passwd'),
    );
  });

  it('rejects sessionId containing a path separator', async () => {
    env = makeEnv('test-host');
    writePathMap(env.testHome, {});
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('abc/def')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: invalid session id: abc/def'),
    );
  });

  it('FATALs with a schema error when path-map.json is missing the projects field', async () => {
    // path-map.json parses but has no `projects` key. Without the explicit
    // schema check the bare PathMap cast would let Object.entries(undefined)
    // throw and bypass the controlled [nomad] FATAL: contract.
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-orig-host-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{}');
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('abc-123')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: path-map.json invalid schema: "projects" must be an object'),
    );
  });

  it('FATALs with a schema error when a project entry maps to null instead of a hosts object', async () => {
    // Per-entry guard so the downstream Object.values(hosts).includes(...)
    // call cannot throw mid-flow on a malformed map.
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-orig-host-foo', 'abc-123', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      '{"projects":{"broken":null}}',
    );
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('abc-123')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'FATAL: path-map.json invalid schema: project "broken" hosts must be an object',
      ),
    );
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

  it('FATALs with "no cwd field found" when transcript has only file-history-snapshot lines', async () => {
    // extractRecordedCwd scans for the first line carrying a cwd; if every
    // line is a snapshot (no cwd field), it returns null and resumeCmd hits
    // the dedicated FATAL line for that case.
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-no-cwd', 'cwdless-id', [
      JSON.stringify({ type: 'file-history-snapshot', fileName: 'a' }),
      JSON.stringify({ type: 'file-history-snapshot', fileName: 'b' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'test-host': '/tmp/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('cwdless-id')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL: no cwd field found'));
  });

  it('FATALs when path-map.json is missing entirely', async () => {
    // makeEnv scaffolds claude-nomad/ but writePathMap is the only way the
    // file gets written. With the transcript present and the map missing,
    // resumeCmd must hit the dedicated "path-map.json missing" FATAL.
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-some-encoded', 'no-map-id', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    const { resumeCmd } = await import('./resume.ts');
    expect(() => resumeCmd('no-map-id')).toThrow('exit:1');
    expect(env.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL: path-map.json missing'),
    );
  });

  it('scans past encoded dirs that do not contain the session before returning the match', async () => {
    // findTranscriptPath iterates every encoded dir under projectsRoot until
    // one contains `<sessionId>.jsonl`. The branch that skips a non-matching
    // dir is only exercised when at least one decoy dir precedes the real one.
    env = makeEnv('test-host');
    mkdirSync(join(env.testHome, '.claude', 'projects', '-decoy-dir'), { recursive: true });
    writeTranscript(env.testHome, '-real-encoded', 'multi-id', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': '/tmp/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('multi-id');
    expect(env.logSpy).toHaveBeenCalledWith(`cd '/tmp/foo' && claude --resume 'multi-id'`);
  });

  it('skips non-snapshot lines that lack a cwd field and continues scanning', async () => {
    // extractRecordedCwd's cwd check is `typeof obj.cwd === 'string' && length > 0`.
    // A non-snapshot line without a cwd field must not return undefined-as-cwd;
    // the loop continues to the next line. Without this case, the typeof !=='string'
    // branch never fires (snapshot lines short-circuit higher up).
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-no-cwd-line', 'noflag-id', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', text: 'no cwd here' }),
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': '/tmp/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('noflag-id');
    expect(env.logSpy).toHaveBeenCalledWith(`cd '/tmp/foo' && claude --resume 'noflag-id'`);
  });

  it('skips non-JSON transcript lines and continues to the first valid cwd', async () => {
    // Transcripts can be appended mid-write or contain garbage from a
    // truncated write. extractRecordedCwd's try/catch swallows parse errors
    // and scans onward; the test asserts a junk line in front of a valid one
    // does not abort the scan.
    env = makeEnv('test-host');
    writeTranscript(env.testHome, '-partial-encoded', 'partial-id', [
      JSON.stringify({ type: 'file-history-snapshot' }),
      '{not valid json',
      JSON.stringify({ type: 'user', cwd: '/orig/host/foo' }),
    ]);
    writePathMap(env.testHome, {
      foo: { 'orig-host': '/orig/host/foo', 'test-host': '/tmp/foo' },
    });
    const { resumeCmd } = await import('./resume.ts');
    resumeCmd('partial-id');
    expect(env.logSpy).toHaveBeenCalledWith(`cd '/tmp/foo' && claude --resume 'partial-id'`);
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
    expect(env.errorSpy).toHaveBeenCalledWith(expect.stringContaining('/strange/path/not/in/map'));
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

  // Spaces in localPath must survive `eval` so cd lands at the intended
  // dir, not "cd" with three args dropping into /local/mapped.
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

  // Single quotes in either argument get escaped via the POSIX '\''
  // pattern (close quote, escaped quote, reopen quote).
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
