import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';
import type * as utilsFsModule from './utils.fs.ts';

/**
 * Unit tests for the pure TDD seams in `commands.redact.core.ts` and the
 * `cmdRedact` command in `commands.redact.ts`. All filesystem calls that would
 * mutate state are either executed against a temp dir or mocked via
 * `vi.doMock('node:fs')`.
 */

// ---------------------------------------------------------------------------
// redactSpan (pure)
// ---------------------------------------------------------------------------

describe('redactSpan (pure)', () => {
  it('replaces the span at the given 1-indexed columns', async () => {
    const { redactSpan } = await import('./commands.redact.core.ts');
    // "hello secret world" -- 'secret' at 0-indexed 6-11; startCol=7, endCol=12
    const line = 'hello secret world';
    const result = redactSpan(line, 7, 12, 'test-rule');
    expect(result).toBe('hello [REDACTED:test-rule] world');
  });

  it('produces a result that JSON.parse accepts when the span is inside a JSON string', async () => {
    const { redactSpan } = await import('./commands.redact.core.ts');
    // Simulate a JSONL line: {"text":"my-secret-token","other":1}
    // 'my-secret-token' at 0-indexed 9-23; startCol=10, endCol=24
    const line = '{"text":"my-secret-token","other":1}';
    const result = redactSpan(line, 10, 24, 'github-pat');
    expect(() => {
      JSON.parse(result);
    }).not.toThrow();
    const parsed = JSON.parse(result) as { text: string };
    expect(parsed.text).toBe('[REDACTED:github-pat]');
  });

  it('handles a span at the very start of the line', async () => {
    const { redactSpan } = await import('./commands.redact.core.ts');
    // 'secret' at 0-indexed 0-5; startCol=1, endCol=6; 'X' is at position 6
    const result = redactSpan('secretXrest', 1, 6, 'r1');
    expect(result).toBe('[REDACTED:r1]Xrest');
  });

  it('handles a span at the very end of the line', async () => {
    const { redactSpan } = await import('./commands.redact.core.ts');
    // 'secret' at 0-indexed 6-11; startCol=7, endCol=12; slice(12)=''
    const result = redactSpan('prefixsecret', 7, 12, 'r1');
    expect(result).toBe('prefix[REDACTED:r1]');
  });
});

// ---------------------------------------------------------------------------
// applyRedactions (pure)
// ---------------------------------------------------------------------------

describe('applyRedactions (pure)', () => {
  it('redacts a single finding on one line', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    // Line 2: {"k":"secret"} -- 'secret' at 0-indexed 6-11; startCol=7, endCol=12
    const content = 'line1\n{"k":"secret"}\nline3';
    const result = applyRedactions(content, [
      { StartLine: 2, StartColumn: 7, EndColumn: 12, RuleID: 'r1' },
    ]);
    expect(result).toBe('line1\n{"k":"[REDACTED:r1]"}\nline3');
  });

  it('applies two same-line findings in descending column order (no offset drift)', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    // Line: {"a":"AAA","b":"BBB"}
    // 'AAA' at 0-indexed positions 6-8 => StartColumn=7, EndColumn=9 (slice(9) = '","b":"BBB"}')
    // 'BBB' at 0-indexed positions 16-18 => StartColumn=17, EndColumn=19 (slice(19) = '"}')
    const line = '{"a":"AAA","b":"BBB"}';
    const result = applyRedactions(line, [
      { StartLine: 1, StartColumn: 7, EndColumn: 9, RuleID: 'rule-a' },
      { StartLine: 1, StartColumn: 17, EndColumn: 19, RuleID: 'rule-b' },
    ]);
    // Both spans must be replaced; the order of application must not corrupt either
    expect(result).toContain('[REDACTED:rule-a]');
    expect(result).toContain('[REDACTED:rule-b]');
    // The result must still be valid JSON
    expect(() => {
      JSON.parse(result);
    }).not.toThrow();
    const parsed = JSON.parse(result) as { a: string; b: string };
    expect(parsed.a).toBe('[REDACTED:rule-a]');
    expect(parsed.b).toBe('[REDACTED:rule-b]');
  });

  it('skips a finding whose StartLine is out of range', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = 'only one line';
    const result = applyRedactions(content, [
      { StartLine: 99, StartColumn: 1, EndColumn: 5, RuleID: 'r1' },
    ]);
    expect(result).toBe('only one line');
  });

  it('handles an empty findings array (content unchanged)', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = 'unchanged content';
    expect(applyRedactions(content, [])).toBe('unchanged content');
  });
});

// ---------------------------------------------------------------------------
// formatFingerprint (pure)
// ---------------------------------------------------------------------------

describe('formatFingerprint (pure)', () => {
  it('appends exactly one trailing newline', async () => {
    const { formatFingerprint } = await import('./commands.redact.core.ts');
    expect(formatFingerprint('file:rule:42')).toBe('file:rule:42\n');
  });

  it('strips embedded \\n from the fingerprint', async () => {
    const { formatFingerprint } = await import('./commands.redact.core.ts');
    const result = formatFingerprint('file:rule\n:42');
    expect(result).toBe('file:rule:42\n');
    expect(result.split('\n').length).toBe(2); // one content line + trailing empty
  });

  it('strips embedded \\r from the fingerprint', async () => {
    const { formatFingerprint } = await import('./commands.redact.core.ts');
    const result = formatFingerprint('file\r:rule:42');
    expect(result).toBe('file:rule:42\n');
  });

  it('strips both \\r and \\n (injection attempt)', async () => {
    const { formatFingerprint } = await import('./commands.redact.core.ts');
    const result = formatFingerprint('a\r\nb\nc');
    // All \r and \n stripped, one trailing \n added
    expect(result).toBe('abc\n');
  });
});

// ---------------------------------------------------------------------------
// isRecentlyModified (pure)
// ---------------------------------------------------------------------------

describe('isRecentlyModified (pure)', () => {
  it('returns true when mtime is within threshold', async () => {
    const { isRecentlyModified } = await import('./commands.redact.core.ts');
    const now = 1_000_000;
    const mtime = now - 1000; // 1 second ago
    expect(isRecentlyModified(mtime, now)).toBe(true);
  });

  it('returns false when mtime equals threshold (boundary: not strictly less)', async () => {
    const { isRecentlyModified } = await import('./commands.redact.core.ts');
    const threshold = 5 * 60 * 1000;
    const now = 1_000_000;
    const mtime = now - threshold; // exactly at threshold
    expect(isRecentlyModified(mtime, now)).toBe(false);
  });

  it('returns false when mtime is older than threshold', async () => {
    const { isRecentlyModified } = await import('./commands.redact.core.ts');
    const now = 1_000_000;
    const mtime = now - 6 * 60 * 1000; // 6 minutes ago
    expect(isRecentlyModified(mtime, now)).toBe(false);
  });

  it('honours a custom threshold', async () => {
    const { isRecentlyModified } = await import('./commands.redact.core.ts');
    const now = 1_000_000;
    const mtime = now - 2000;
    expect(isRecentlyModified(mtime, now, 1000)).toBe(false);
    expect(isRecentlyModified(mtime, now, 3000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendGitleaksIgnore (fs-mocked)
// ---------------------------------------------------------------------------

describe('appendGitleaksIgnore (fs-mocked)', () => {
  let originalNomadRepo: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-agi-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) {
      process.env.NOMAD_REPO = originalNomadRepo;
    } else {
      delete process.env.NOMAD_REPO;
    }
  });

  it('calls appendFileSync with the sanitized fingerprint at REPO_HOME/.gitleaksignore', async () => {
    const appendSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, appendFileSync: appendSpy };
    });
    const { appendGitleaksIgnore } = await import('./commands.redact.core.ts');
    appendGitleaksIgnore('shared/projects/foo/bar.jsonl:github-pat:10');
    expect(appendSpy).toHaveBeenCalledOnce();
    const [path, content] = appendSpy.mock.calls[0] as [string, string];
    expect(path).toBe(join(testHome, '.gitleaksignore'));
    expect(content).toBe('shared/projects/foo/bar.jsonl:github-pat:10\n');
  });

  it('strips newlines from the fingerprint before appending', async () => {
    const appendSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, appendFileSync: appendSpy };
    });
    const { appendGitleaksIgnore } = await import('./commands.redact.core.ts');
    appendGitleaksIgnore('file:rule\n:42');
    const [, content] = appendSpy.mock.calls[0] as [string, string];
    expect(content).toBe('file:rule:42\n');
  });
});

// ---------------------------------------------------------------------------
// cmdRedact command
// ---------------------------------------------------------------------------

describe('cmdRedact', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-cmd-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('exits 1 on an invalid session id (contains slash)', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error('process.exit');
      });
    const { cmdRedact } = await import('./commands.redact.ts');
    expect(() => cmdRedact({ id: 'bad/id' })).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 on an empty session id', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error('process.exit');
      });
    const { cmdRedact } = await import('./commands.redact.ts');
    expect(() => cmdRedact({ id: '' })).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 on a session id longer than 128 chars', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error('process.exit');
      });
    const { cmdRedact } = await import('./commands.redact.ts');
    expect(() => cmdRedact({ id: 'a'.repeat(129) })).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('sets exitCode=1 when the local transcript cannot be resolved (no path-map)', async () => {
    // REPO_HOME exists (testHome) but has no path-map.json
    const { cmdRedact } = await import('./commands.redact.ts');
    const originalExitCode = process.exitCode;
    try {
      cmdRedact({ id: 'abc123' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('logs refusal and writes nothing when transcript is recently modified', async () => {
    const claudeHome = join(testHome, '.claude');
    const encodedDir = '-home-norm-git-myproject';
    const projectsDir = join(claudeHome, 'projects', encodedDir);
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'session1.jsonl');
    const originalContent = '{"text":"hello"}\n';
    writeFileSync(transcriptPath, originalContent);
    const nowMs = Date.now();

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
      }),
    );

    const { cmdRedact } = await import('./commands.redact.ts');
    // Inject nowMs 1 second after mtime (within 5-minute threshold)
    cmdRedact(
      {
        id: 'session1',
        findings: [{ StartLine: 1, StartColumn: 10, EndColumn: 14, RuleID: 'test-rule' }],
      },
      () => nowMs + 1000,
    );
    // File must be unchanged (refusal, no write)
    const { readFileSync: realRead } = await import('node:fs');
    expect(realRead(transcriptPath, 'utf8')).toBe(originalContent);
  });

  it('dry-run: writes nothing (file unchanged, no backup dir created)', async () => {
    const claudeHome = join(testHome, '.claude');
    const encodedDir = '-home-norm-git-myproject';
    const projectsDir = join(claudeHome, 'projects', encodedDir);
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess2.jsonl');
    const originalContent = '{"text":"hello"}\n';
    writeFileSync(transcriptPath, originalContent);

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
      }),
    );

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;
    cmdRedact(
      {
        id: 'sess2',
        dryRun: true,
        findings: [{ StartLine: 1, StartColumn: 10, EndColumn: 14, RuleID: 'test-rule' }],
      },
      () => farFuture,
    );
    // File must be unchanged
    const { readFileSync: realRead, existsSync: realExists } = await import('node:fs');
    expect(realRead(transcriptPath, 'utf8')).toBe(originalContent);
    // No backup directory should have been created
    const backupDir = join(testHome, '.cache', 'claude-nomad', 'backup');
    expect(realExists(backupDir)).toBe(false);
  });

  it('inactive path: backup called before writeFileSync, content is redacted', async () => {
    const claudeHome = join(testHome, '.claude');
    const encodedDir = '-home-norm-git-myproject';
    const projectsDir = join(claudeHome, 'projects', encodedDir);
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess3.jsonl');
    const original = '{"text":"hello"}\n{"text":"world"}\n';
    writeFileSync(transcriptPath, original);

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          myproject: { 'test-host': '/home/norm/git/myproject' },
        },
      }),
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;
    cmdRedact(
      {
        id: 'sess3',
        findings: [{ StartLine: 1, StartColumn: 10, EndColumn: 14, RuleID: 'test-rule' }],
      },
      () => farFuture,
    );
    expect(backupSpy).toHaveBeenCalledOnce();
    // The file should be written with a redaction on line 1, col 9-14
    const { readFileSync: realRead } = await import('node:fs');
    const written = realRead(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:test-rule]');
    expect(written).toContain('{"text":"world"}');
  });

  it('--rule filters findings to the matching ruleId only', async () => {
    const claudeHome = join(testHome, '.claude');
    const encodedDir = '-home-norm-git-myproject';
    const projectsDir = join(claudeHome, 'projects', encodedDir);
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess4.jsonl');
    // Two secrets on different lines
    const original = '{"a":"AAAAA"}\n{"b":"BBBBB"}\n';
    writeFileSync(transcriptPath, original);

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          myproject: { 'test-host': '/home/norm/git/myproject' },
        },
      }),
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;
    cmdRedact(
      {
        id: 'sess4',
        rule: 'rule-a',
        findings: [
          { StartLine: 1, StartColumn: 7, EndColumn: 11, RuleID: 'rule-a' },
          { StartLine: 2, StartColumn: 7, EndColumn: 11, RuleID: 'rule-b' },
        ],
      },
      () => farFuture,
    );

    const { readFileSync: realRead } = await import('node:fs');
    const written = realRead(transcriptPath, 'utf8');
    // Only rule-a finding should be redacted
    expect(written).toContain('[REDACTED:rule-a]');
    expect(written).not.toContain('[REDACTED:rule-b]');
    // Line 2 original value should be intact
    expect(written).toContain('BBBBB');
  });
});
