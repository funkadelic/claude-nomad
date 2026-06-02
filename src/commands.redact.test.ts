import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsModule from 'node:fs';
import type * as utilsFsModule from './utils.fs.ts';
import type * as lockfileModule from './utils.lockfile.ts';
import type { Finding } from './push-gitleaks.scan.ts';

/**
 * Unit tests for the pure TDD seams in `commands.redact.core.ts` and the
 * `cmdRedact` command in `commands.redact.ts`. All filesystem calls that would
 * mutate state are either executed against a temp dir or mocked via
 * `vi.doMock('node:fs')`.
 */

/**
 * Assemble a github-pat-shaped fixture token from fragments so no contiguous
 * `ghp_<36>` literal is stored in source-controlled bytes (the gitleaks CI
 * check scans the working tree and would flag a committed PAT-shaped literal).
 * Mirrors the split-fragment convention in `push-gitleaks.test.ts`.
 *
 * @param body The 36-char token body that follows the `ghp_` prefix.
 * @returns A `ghp_`-prefixed token assembled at runtime.
 */
const ghpFixture = (body: string): string => ['gh', 'p_', body].join('');

// ---------------------------------------------------------------------------
// collectMatchIntervals (pure)
// ---------------------------------------------------------------------------

describe('collectMatchIntervals (pure)', () => {
  it('returns an interval for a single occurrence', async () => {
    const { collectMatchIntervals } = await import('./commands.redact.core.ts');
    const result = collectMatchIntervals('hello secret world', [
      { StartLine: 1, Match: 'secret', RuleID: 'r1' },
    ]);
    expect(result).toEqual([{ start: 6, end: 12, ruleId: 'r1' }]);
  });

  it('returns two intervals for two non-overlapping occurrences of the same value', async () => {
    const { collectMatchIntervals } = await import('./commands.redact.core.ts');
    const result = collectMatchIntervals('ab ab', [{ StartLine: 1, Match: 'ab', RuleID: 'r1' }]);
    expect(result).toEqual([
      { start: 0, end: 2, ruleId: 'r1' },
      { start: 3, end: 5, ruleId: 'r1' },
    ]);
  });

  it('returns empty array when Match is not present in content', async () => {
    const { collectMatchIntervals } = await import('./commands.redact.core.ts');
    expect(collectMatchIntervals('hello', [{ StartLine: 1, Match: 'xyz', RuleID: 'r1' }])).toEqual(
      [],
    );
  });

  it('skips a finding with an empty Match', async () => {
    const { collectMatchIntervals } = await import('./commands.redact.core.ts');
    expect(collectMatchIntervals('hello', [{ StartLine: 1, Match: '', RuleID: 'r1' }])).toEqual([]);
  });

  it('returns empty array for an empty findings list', async () => {
    const { collectMatchIntervals } = await import('./commands.redact.core.ts');
    expect(collectMatchIntervals('hello', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeIntervals (pure)
// ---------------------------------------------------------------------------

describe('mergeIntervals (pure)', () => {
  it('returns empty array for empty input', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    expect(mergeIntervals([])).toEqual([]);
  });

  it('returns a single interval unchanged', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    expect(mergeIntervals([{ start: 2, end: 5, ruleId: 'r1' }])).toEqual([
      { start: 2, end: 5, ruleId: 'r1' },
    ]);
  });

  it('merges two overlapping intervals, keeping the first ruleId', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 0, end: 5, ruleId: 'r1' },
      { start: 3, end: 8, ruleId: 'r2' },
    ]);
    expect(result).toEqual([{ start: 0, end: 8, ruleId: 'r1' }]);
  });

  it('merges adjacent (touching) intervals', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 0, end: 3, ruleId: 'r1' },
      { start: 3, end: 6, ruleId: 'r2' },
    ]);
    expect(result).toEqual([{ start: 0, end: 6, ruleId: 'r1' }]);
  });

  it('does not merge non-overlapping intervals', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 0, end: 3, ruleId: 'r1' },
      { start: 5, end: 8, ruleId: 'r2' },
    ]);
    expect(result).toEqual([
      { start: 0, end: 3, ruleId: 'r1' },
      { start: 5, end: 8, ruleId: 'r2' },
    ]);
  });

  it('handles unsorted input (sorts before merging)', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 5, end: 8, ruleId: 'r2' },
      { start: 0, end: 3, ruleId: 'r1' },
    ]);
    expect(result).toEqual([
      { start: 0, end: 3, ruleId: 'r1' },
      { start: 5, end: 8, ruleId: 'r2' },
    ]);
  });

  it('longer interval at same start wins ruleId over shorter interval', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 0, end: 3, ruleId: 'short' },
      { start: 0, end: 7, ruleId: 'long' },
    ]);
    expect(result).toEqual([{ start: 0, end: 7, ruleId: 'long' }]);
  });

  it('merges three mutually overlapping intervals into one', async () => {
    const { mergeIntervals } = await import('./commands.redact.core.ts');
    const result = mergeIntervals([
      { start: 0, end: 5, ruleId: 'r1' },
      { start: 2, end: 7, ruleId: 'r2' },
      { start: 4, end: 9, ruleId: 'r3' },
    ]);
    expect(result).toEqual([{ start: 0, end: 9, ruleId: 'r1' }]);
  });
});

// ---------------------------------------------------------------------------
// applyRedactions (pure)
// ---------------------------------------------------------------------------

describe('applyRedactions (pure)', () => {
  it('redacts a single finding by Match value', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = 'line1\n{"k":"secret"}\nline3';
    const result = applyRedactions(content, [{ StartLine: 1, Match: 'secret', RuleID: 'r1' }]);
    expect(result).toBe('line1\n{"k":"[REDACTED:r1]"}\nline3');
  });

  it('redacts two distinct Match values on the same line', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const line = '{"a":"AAA","b":"BBB"}';
    const result = applyRedactions(line, [
      { StartLine: 1, Match: 'AAA', RuleID: 'rule-a' },
      { StartLine: 1, Match: 'BBB', RuleID: 'rule-b' },
    ]);
    expect(result).toContain('[REDACTED:rule-a]');
    expect(result).toContain('[REDACTED:rule-b]');
    expect(() => JSON.parse(result) as unknown).not.toThrow();
    const parsed = JSON.parse(result) as { a: string; b: string };
    expect(parsed.a).toBe('[REDACTED:rule-a]');
    expect(parsed.b).toBe('[REDACTED:rule-b]');
  });

  it('handles an out-of-range StartLine gracefully (value is still replaced if present)', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    // Value-based redaction operates on the whole content; StartLine is not
    // used for replacement but kept in the type for caller reference.
    const content = 'only one line';
    const result = applyRedactions(content, [{ StartLine: 99, Match: 'xyz', RuleID: 'r1' }]);
    // 'xyz' is not in content, so unchanged
    expect(result).toBe('only one line');
  });

  it('handles an empty findings array (content unchanged)', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = 'unchanged content';
    expect(applyRedactions(content, [])).toBe('unchanged content');
  });

  it('skips a finding whose Match is empty (no-op guard)', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = 'some content';
    const result = applyRedactions(content, [{ StartLine: 1, Match: '', RuleID: 'r1' }]);
    expect(result).toBe('some content');
  });

  it('redacts the longer Match first when one is a substring of another', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    // 'ghp_abc123' contains 'abc123'; longer must be replaced first so 'abc123'
    // match does not consume part of 'ghp_abc123' leaving a broken token.
    const line = 'token=ghp_abc123 other=abc123';
    const result = applyRedactions(line, [
      { StartLine: 1, Match: 'abc123', RuleID: 'short-rule' },
      { StartLine: 1, Match: 'ghp_abc123', RuleID: 'long-rule' },
    ]);
    expect(result).toBe('token=[REDACTED:long-rule] other=[REDACTED:short-rule]');
  });

  it('redacts across multiple lines when the same value appears more than once', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const content = '{"a":"SECRET"}\n{"b":"SECRET"}\n';
    const result = applyRedactions(content, [{ StartLine: 1, Match: 'SECRET', RuleID: 'r1' }]);
    expect(result).toBe('{"a":"[REDACTED:r1]"}\n{"b":"[REDACTED:r1]"}\n');
  });

  it('overlap: two findings sharing a middle span collapse to one token with no fragment', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    // 'XYabc' and 'abcZW' share the middle 'abc'; the union 'XYabcZW' must be
    // fully replaced with no surviving fragment ('XY' or 'ZW' adjacent to a token).
    const content = 'XYabcZW';
    const result = applyRedactions(content, [
      { StartLine: 1, Match: 'XYabc', RuleID: 'rule-left' },
      { StartLine: 1, Match: 'abcZW', RuleID: 'rule-right' },
    ]);
    // The entire span must be replaced by a single redaction token.
    expect(result).not.toContain('abc');
    expect(result).not.toContain('XY');
    expect(result).not.toContain('ZW');
    expect(result).toMatch(/^\[REDACTED:[^\]]+\]$/);
  });
});

// ---------------------------------------------------------------------------
// applyRedactions regression: column-offset bug (github-pat in JSONL transcript)
// ---------------------------------------------------------------------------

describe('applyRedactions regression: value-based redaction preserves valid JSON', () => {
  /**
   * Regression for the column-offset bug where gitleaks StartColumn/EndColumn
   * did not align to JS string indices inside long JSON-string content:
   * the leading secret char was left behind and the closing JSON quote was
   * consumed, producing invalid JSON.
   */
  it('fully removes a 40-char github-pat from a realistic JSONL transcript line', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const pat = ghpFixture('0123456789abcdefghijABCDEFGHIJ012345');
    const line = `{"message":{"role":"assistant","content":"export GITHUB_TOKEN=${pat}"}}`;
    const finding = { StartLine: 1, Match: pat, RuleID: 'github-pat' };
    const result = applyRedactions(line, [finding]);

    // (a) No part of the secret survives
    expect(result).not.toContain('ghp_');
    expect(result).not.toContain('0123456789abcdefghijABCDEFGHIJ012345');

    // (b) Redaction token present
    expect(result).toContain('[REDACTED:github-pat]');

    // (c) Result is valid JSON and the content field is correct
    const parsed = JSON.parse(result) as {
      message: { role: string; content: string };
    };
    expect(parsed.message.content).toBe('export GITHUB_TOKEN=[REDACTED:github-pat]');
  });

  it('redacts two distinct secrets on one line and produces valid JSON', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const pat1 = ghpFixture('0123456789abcdefghijABCDEFGHIJ012345');
    const pat2 = ghpFixture('abcdefghijABCDEFGHIJ0123456789zyxwvu');
    const line = `{"a":"${pat1}","b":"${pat2}"}`;
    const result = applyRedactions(line, [
      { StartLine: 1, Match: pat1, RuleID: 'github-pat' },
      { StartLine: 1, Match: pat2, RuleID: 'github-pat' },
    ]);
    expect(result).not.toContain('ghp_');
    expect(JSON.parse(result)).toMatchObject({
      a: '[REDACTED:github-pat]',
      b: '[REDACTED:github-pat]',
    });
  });

  it('handles a Match that is a substring of another Match on the same line', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const full = ghpFixture('0123456789abcdefghijABCDEFGHIJ012345');
    const sub = '0123456789abcdefghijABCDEFGHIJ012345'; // suffix of full
    const line = `{"token":"${full}"}`;
    const result = applyRedactions(line, [
      { StartLine: 1, Match: full, RuleID: 'github-pat' },
      { StartLine: 1, Match: sub, RuleID: 'generic-secret' },
    ]);
    // The full token should be gone; the suffix alone is now absent too (was
    // inside the full token which was replaced first).
    expect(result).not.toContain('ghp_');
    expect(result).not.toContain(sub);
    expect(() => JSON.parse(result) as unknown).not.toThrow();
  });

  it('treats an empty-Match finding as a no-op', async () => {
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const line = '{"text":"hello"}';
    const result = applyRedactions(line, [{ StartLine: 1, Match: '', RuleID: 'github-pat' }]);
    expect(result).toBe('{"text":"hello"}');
    expect(() => JSON.parse(result) as unknown).not.toThrow();
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
        findings: [{ StartLine: 1, Match: 'hello', RuleID: 'test-rule' }],
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
        findings: [{ StartLine: 1, Match: 'hello', RuleID: 'test-rule' }],
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
        findings: [{ StartLine: 1, Match: 'hello', RuleID: 'test-rule' }],
      },
      () => farFuture,
    );
    expect(backupSpy).toHaveBeenCalledOnce();
    // The file should be written with a redaction on line 1
    const { readFileSync: realRead } = await import('node:fs');
    const written = realRead(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:test-rule]');
    expect(written).toContain('{"text":"world"}');
  });

  it('backup base derives from the centralized HOME constant (not process.env.HOME ?? "~")', async () => {
    // With HOME set to testHome, backupBeforeWrite must be called with a ts
    // whose computed base is <testHome>/.cache/claude-nomad/backup/...
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-homebck.jsonl');
    writeFileSync(transcriptPath, '{"text":"hello"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
      }),
    );

    // Capture the ts value that freshBackupTs receives as its base argument.
    let capturedBase: string | undefined;
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return {
        ...actual,
        freshBackupTs: (base: string) => {
          capturedBase = base;
          return 'ts-fixed';
        },
        backupBeforeWrite: vi.fn(),
      };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;
    cmdRedact(
      {
        id: 'sess-homebck',
        findings: [{ StartLine: 1, Match: 'hello', RuleID: 'test-rule' }],
      },
      () => farFuture,
    );

    // The backup base must start with the testHome (the HOME set in beforeEach).
    expect(capturedBase).toBeDefined();
    expect(capturedBase!.startsWith(testHome)).toBe(true);
    expect(capturedBase).toBe(join(testHome, '.cache', 'claude-nomad', 'backup'));
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
          { StartLine: 1, Match: 'AAAAA', RuleID: 'rule-a' },
          { StartLine: 2, Match: 'BBBBB', RuleID: 'rule-b' },
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

// ---------------------------------------------------------------------------
// cmdRedact standalone (no opts.findings -- scan DI path)
// ---------------------------------------------------------------------------

/**
 * Helper to build a standard test transcript in a temp directory, with a
 * path-map.json pointing at it. Returns the transcript path and the far-future
 * clock value used to bypass the live-session guard.
 */
function makeTestTranscript(
  testHome: string,
  sessionId: string,
  content: string,
): { transcriptPath: string; farFuture: number } {
  const claudeHome = join(testHome, '.claude');
  const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
  mkdirSync(projectsDir, { recursive: true });
  const transcriptPath = join(projectsDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, content);
  writeFileSync(
    join(testHome, 'path-map.json'),
    JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
  );
  return { transcriptPath, farFuture: Date.now() + 10 * 60 * 1000 };
}

describe('cmdRedact standalone (scan DI)', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-scan-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.doUnmock('./utils.fs.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    const orig = process.exitCode;
    process.exitCode = orig === 1 ? undefined : orig;
  });

  it('backs up and redacts when injected scan returns a finding', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-scan1',
      '{"text":"my-secret-value"}\n',
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-secret',
        StartLine: 1,
        Match: 'my-secret-value',
        StartColumn: 1,
        EndColumn: 15,
        File: transcriptPath,
        Fingerprint: 'fp1',
      },
    ];
    cmdRedact({ id: 'sess-scan1' }, () => farFuture, fakeScan);

    expect(backupSpy).toHaveBeenCalledOnce();
    const { readFileSync: realRead } = await import('node:fs');
    const written = realRead(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:test-secret]');
    expect(written).not.toContain('my-secret-value');
  });

  it('logs "no findings" and writes nothing when injected scan returns []', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-scan2',
      '{"text":"clean"}\n',
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const fakeScan = (_p: string): Finding[] => [];
    const originalExitCode = process.exitCode;
    cmdRedact({ id: 'sess-scan2' }, () => farFuture, fakeScan);

    // exit code must not become 1 (clean no-op)
    expect(process.exitCode).toBe(originalExitCode);
    const { readFileSync: realRead } = await import('node:fs');
    expect(realRead(transcriptPath, 'utf8')).toBe('{"text":"clean"}\n');
  });

  it('sets exitCode=1 when injected scan returns null (scan failed, not "no findings")', async () => {
    makeTestTranscript(testHome, 'sess-scan3', '{"text":"content"}\n');

    const { cmdRedact } = await import('./commands.redact.ts');
    const fakeScan = (_p: string): null => null;
    const prevExitCode = process.exitCode;
    try {
      cmdRedact({ id: 'sess-scan3' }, () => Date.now() + 10 * 60 * 1000, fakeScan);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('applies rule filter to scan results', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-scan4',
      '{"a":"AAAAA","b":"BBBBB"}\n',
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'rule-a',
        StartLine: 1,
        Match: 'AAAAA',
        StartColumn: 1,
        EndColumn: 5,
        File: transcriptPath,
        Fingerprint: 'fp-a',
      },
      {
        RuleID: 'rule-b',
        StartLine: 1,
        Match: 'BBBBB',
        StartColumn: 10,
        EndColumn: 14,
        File: transcriptPath,
        Fingerprint: 'fp-b',
      },
    ];
    cmdRedact({ id: 'sess-scan4', rule: 'rule-a' }, () => farFuture, fakeScan);

    const { readFileSync: realRead } = await import('node:fs');
    const written = realRead(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:rule-a]');
    expect(written).not.toContain('[REDACTED:rule-b]');
    expect(written).toContain('BBBBB');
  });

  it('dry-run with scanned findings prints plan and writes nothing', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-scan5',
      '{"text":"secret-val"}\n',
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'github-pat',
        StartLine: 1,
        Match: 'secret-val',
        StartColumn: 1,
        EndColumn: 10,
        File: transcriptPath,
        Fingerprint: 'fp-dry',
      },
    ];
    cmdRedact({ id: 'sess-scan5', dryRun: true }, () => farFuture, fakeScan);

    const { readFileSync: realRead } = await import('node:fs');
    expect(realRead(transcriptPath, 'utf8')).toBe('{"text":"secret-val"}\n');
  });

  it('idempotent re-run: scan returns [] after redaction, logs "no findings", clean no-op', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-scan6',
      '{"text":"[REDACTED:github-pat]"}\n',
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    // Simulate scan finding nothing (already redacted)
    const fakeScan = (_p: string): Finding[] => [];
    const prevExitCode = process.exitCode;
    cmdRedact({ id: 'sess-scan6' }, () => farFuture, fakeScan);

    expect(process.exitCode).toBe(prevExitCode);
    const { readFileSync: realRead } = await import('node:fs');
    // Content unchanged
    expect(realRead(transcriptPath, 'utf8')).toBe('{"text":"[REDACTED:github-pat]"}\n');
  });
});

// ---------------------------------------------------------------------------
// scanFile (integration, real gitleaks)
// ---------------------------------------------------------------------------

describe('scanFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nomad-scanfile-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a finding with matching RuleID and StartLine for a github-pat-shaped value', async () => {
    // Skip if gitleaks is not installed in this environment
    const { execFileSync: realExec } = await import('node:child_process');
    try {
      realExec('gitleaks', ['version'], { stdio: 'ignore' });
    } catch {
      return; // gitleaks not available; skip
    }

    const { scanFile: realScanFile } = await import('./push-gitleaks.scan.ts');
    // A realistic github fine-grained PAT pattern (40 hex chars after the prefix)
    const pat = ghpFixture('0123456789abcdefghijABCDEFGHIJ012345');
    const filePath = join(tmpDir, 'transcript.jsonl');
    writeFileSync(filePath, `{"text":"export GITHUB_TOKEN=${pat}"}\n`);

    const findings = realScanFile(filePath);
    expect(findings).not.toBeNull();
    // Must have at least one finding
    expect(findings!.length).toBeGreaterThan(0);
    // The first finding should be on line 1 and have a github-related rule
    const f = findings![0];
    expect(f.StartLine).toBe(1);
    expect(f.RuleID).toBeTruthy();
  });

  it('returns [] for a file with no secrets', async () => {
    // Skip if gitleaks is not installed in this environment
    const { execFileSync: realExec } = await import('node:child_process');
    try {
      realExec('gitleaks', ['version'], { stdio: 'ignore' });
    } catch {
      return; // gitleaks not available; skip
    }

    const { scanFile: realScanFile } = await import('./push-gitleaks.scan.ts');
    const filePath = join(tmpDir, 'clean.jsonl');
    writeFileSync(filePath, '{"text":"nothing sensitive here"}\n');

    const findings = realScanFile(filePath);
    expect(findings).toEqual([]);
  });

  /**
   * Regression guard for the --redact masking bug: scanFile must NOT pass
   * --redact to gitleaks, so Match carries the real secret value (not the
   * literal string "REDACTED"). If Match were masked, applyRedactions would
   * search for "REDACTED" in the transcript and leave the real token in place.
   */
  it('regression: Match is the real token (not "REDACTED") and applyRedactions removes it', async () => {
    // Skip if gitleaks is not installed in this environment
    const { execFileSync: realExec } = await import('node:child_process');
    try {
      realExec('gitleaks', ['version'], { stdio: 'ignore' });
    } catch {
      return; // gitleaks not available; skip
    }

    const { scanFile: realScanFile } = await import('./push-gitleaks.scan.ts');
    const { applyRedactions } = await import('./commands.redact.core.ts');
    const pat = ghpFixture('0123456789abcdefghijABCDEFGHIJ012345');
    const content = `{"message":{"role":"assistant","content":"export GITHUB_TOKEN=${pat}"}}\n`;
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(filePath, content);

    const findings = realScanFile(filePath);
    expect(findings).not.toBeNull();
    expect(findings!.length).toBeGreaterThan(0);

    // Match must be the real token, not the masked placeholder
    const match = findings![0].Match;
    expect(match).not.toBe('REDACTED');
    expect(match.length).toBeGreaterThan(0);

    // applyRedactions must remove the secret using the real Match value
    const redacted = applyRedactions(content, findings!);
    expect(redacted).not.toContain(pat);
    expect(redacted).not.toContain('ghp_');
    // Result must still be valid JSON
    expect(() => JSON.parse(redacted.trim()) as unknown).not.toThrow();
    const parsed = JSON.parse(redacted.trim()) as {
      message: { role: string; content: string };
    };
    expect(parsed.message.content).not.toContain(pat);
    expect(parsed.message.content).toContain('[REDACTED:');
  });
});

// ---------------------------------------------------------------------------
// resolveLiveTranscript: branch + catch coverage
// ---------------------------------------------------------------------------

describe('resolveLiveTranscript: branch and error coverage', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-resolvelive-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns null and swallows the error when path-map.json is malformed', async () => {
    // readJson throws on invalid JSON; the catch must return null, not propagate.
    writeFileSync(join(testHome, 'path-map.json'), '{ this is not valid json');
    const { resolveLiveTranscript } = await import('./commands.redact.ts');
    expect(resolveLiveTranscript('abc123')).toBeNull();
  });

  it('skips a project whose host map has no entry for the current host', async () => {
    // The only project maps a DIFFERENT host, so the `abs === undefined`
    // continue branch is taken for every entry and the result is null.
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'other-host': '/home/other/git/myproject' } } }),
    );
    const { resolveLiveTranscript } = await import('./commands.redact.ts');
    expect(resolveLiveTranscript('abc123')).toBeNull();
  });

  it('returns null when the host entry exists but the transcript file does not exist on disk', async () => {
    // The project has an entry for the current host, but the transcript file
    // is absent from the filesystem. existsSync(live) returns false -> null.
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );
    const { resolveLiveTranscript } = await import('./commands.redact.ts');
    // 'no-such-session' does not exist in the temp fs, so existsSync returns false.
    expect(resolveLiveTranscript('no-such-session')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cmdRedact: remaining branch coverage (missing REPO_HOME, held lock,
// NomadFatal in the try body, rule-scoped no-findings message)
// ---------------------------------------------------------------------------

describe('cmdRedact: branch and error coverage', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-branch-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.lockfile.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    const orig = process.exitCode;
    process.exitCode = orig === 1 ? undefined : orig;
  });

  it('throws NomadFatal (die) when REPO_HOME does not exist', async () => {
    process.env.NOMAD_REPO = join(testHome, 'does-not-exist');
    const { cmdRedact } = await import('./commands.redact.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdRedact({ id: 'abc123' })).toThrow(NomadFatal);
  });

  it('exits 0 without mutation when the lock is already held', async () => {
    process.env.NOMAD_REPO = testHome;
    vi.doMock('./utils.lockfile.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof lockfileModule>();
      return { ...actual, acquireLock: () => null };
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const { cmdRedact } = await import('./commands.redact.ts');
    expect(() => cmdRedact({ id: 'abc123' })).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports a NomadFatal thrown inside the try body via fail + exitCode=1', async () => {
    process.env.NOMAD_REPO = testHome;
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-fatal',
      '{"text":"x"}\n',
    );
    expect(transcriptPath).toContain('sess-fatal');
    const { cmdRedact } = await import('./commands.redact.ts');
    const { NomadFatal } = await import('./utils.ts');
    const throwingScan = (_p: string): Finding[] => {
      throw new NomadFatal('scan blew up');
    };
    const prevExitCode = process.exitCode;
    try {
      // findings omitted, so resolveRedactFindings invokes the throwing scan;
      // the NomadFatal propagates to the catch and is reported (not rethrown).
      cmdRedact({ id: 'sess-fatal' }, () => farFuture, throwingScan);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('logs a rule-scoped "no findings" message when a rule filter yields nothing', async () => {
    process.env.NOMAD_REPO = testHome;
    const { farFuture } = makeTestTranscript(testHome, 'sess-rule', '{"text":"x"}\n');
    const { cmdRedact } = await import('./commands.redact.ts');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Provide a finding that does not match the rule filter, so the filtered
    // findings list is empty and the rule-scoped no-findings branch is taken.
    cmdRedact(
      {
        id: 'sess-rule',
        rule: 'some-other-rule',
        findings: [{ StartLine: 1, Match: 'x', RuleID: 'test-rule' }],
      },
      () => farFuture,
    );
    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('some-other-rule');
  });
});

// ---------------------------------------------------------------------------
// cmdRedact: subagent coverage
// ---------------------------------------------------------------------------

describe('cmdRedact: subagent-only secret is redacted', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-subagent-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.fs.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('redacts agent-1.jsonl when only the subagent has findings; count is non-zero', async () => {
    // Build main transcript (clean) + session dir with a subagent.
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-agent.jsonl');
    writeFileSync(transcriptPath, '{"text":"clean-main"}\n');

    const sessionDir = join(projectsDir, 'sess-agent');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"my-secret-value"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;

    // Main scan returns []; agent scan returns a finding.
    const fakeScan = (p: string): Finding[] => {
      if (p === agentPath) {
        return [
          {
            RuleID: 'agent-secret',
            StartLine: 1,
            Match: 'my-secret-value',
            StartColumn: 9,
            EndColumn: 25,
            File: p,
            Fingerprint: 'fp-agent',
          },
        ];
      }
      return [];
    };

    cmdRedact({ id: 'sess-agent' }, () => farFuture, fakeScan);

    // Agent file must have been redacted.
    const { readFileSync: realRead } = await import('node:fs');
    const agentContent = realRead(agentPath, 'utf8');
    expect(agentContent).toContain('[REDACTED:agent-secret]');
    expect(agentContent).not.toContain('my-secret-value');
    // Backup must have been called for the agent file.
    expect(backupSpy).toHaveBeenCalledOnce();
    expect(backupSpy.mock.calls[0][0]).toBe(agentPath);
  });

  it('live-session guard fires when newest subtree file is within 5 minutes', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-live.jsonl');
    writeFileSync(transcriptPath, '{"text":"main"}\n');

    const sessionDir = join(projectsDir, 'sess-live');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"agent"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    const { cmdRedact } = await import('./commands.redact.ts');
    // Clock is 1 second after the agent file's mtime -> within 5-minute threshold.
    const liveClock = () => statSync(agentPath).mtimeMs + 1000;

    cmdRedact(
      { id: 'sess-live', findings: [{ StartLine: 1, Match: 'agent', RuleID: 'r' }] },
      liveClock,
    );

    // File must be unchanged (refusal, no write).
    const { readFileSync: realRead } = await import('node:fs');
    expect(realRead(transcriptPath, 'utf8')).toBe('{"text":"main"}\n');
  });

  it('--rule filter applies to subagent findings', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-rule-agent.jsonl');
    writeFileSync(transcriptPath, '{"text":"clean"}\n');

    const sessionDir = join(projectsDir, 'sess-rule-agent');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"a":"AAAAA","b":"BBBBB"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;

    const fakeScan = (p: string): Finding[] => {
      if (p === agentPath) {
        return [
          {
            RuleID: 'rule-a',
            StartLine: 1,
            Match: 'AAAAA',
            StartColumn: 5,
            EndColumn: 9,
            File: p,
            Fingerprint: 'fp-a',
          },
          {
            RuleID: 'rule-b',
            StartLine: 1,
            Match: 'BBBBB',
            StartColumn: 15,
            EndColumn: 19,
            File: p,
            Fingerprint: 'fp-b',
          },
        ];
      }
      return [];
    };

    cmdRedact({ id: 'sess-rule-agent', rule: 'rule-a' }, () => farFuture, fakeScan);

    const { readFileSync: realRead } = await import('node:fs');
    const agentContent = realRead(agentPath, 'utf8');
    // Only rule-a finding should be redacted.
    expect(agentContent).toContain('[REDACTED:rule-a]');
    expect(agentContent).not.toContain('[REDACTED:rule-b]');
    expect(agentContent).toContain('BBBBB');
  });

  it('clean agent (scan []) is skipped and does not prevent main-file redaction', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-clean-agent.jsonl');
    writeFileSync(transcriptPath, '{"text":"main-secret"}\n');

    // Create session dir with a CLEAN agent.
    const sessionDir = join(projectsDir, 'sess-clean-agent');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"clean"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;

    // Main has a finding; agent scan returns [] (clean).
    const fakeScan = (p: string): Finding[] => {
      if (p === transcriptPath) {
        return [
          {
            RuleID: 'main-rule',
            StartLine: 1,
            Match: 'main-secret',
            StartColumn: 9,
            EndColumn: 20,
            File: p,
            Fingerprint: 'fp-main',
          },
        ];
      }
      // agent-1.jsonl returns [] -- exercises the found !== null && found.length === 0 branch
      return [];
    };

    cmdRedact({ id: 'sess-clean-agent' }, () => farFuture, fakeScan);

    const { readFileSync: realRead } = await import('node:fs');
    // Main is rewritten.
    const mainContent = realRead(transcriptPath, 'utf8');
    expect(mainContent).toContain('[REDACTED:main-rule]');
    // Agent is unchanged (clean scan).
    expect(realRead(agentPath, 'utf8')).toBe('{"text":"clean"}\n');
    // Backup was called once (main only).
    expect(backupSpy).toHaveBeenCalledOnce();
    expect(backupSpy.mock.calls[0][0]).toBe(transcriptPath);
  });

  it('redacts tool-results/x.txt when only that file has findings', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-toolresult.jsonl');
    writeFileSync(transcriptPath, '{"text":"clean-main"}\n');

    const sessionDir = join(projectsDir, 'sess-toolresult');
    const toolResultsDir = join(sessionDir, 'tool-results');
    mkdirSync(toolResultsDir, { recursive: true });
    const toolFilePath = join(toolResultsDir, 'x.txt');
    writeFileSync(toolFilePath, 'output with tool-secret-value\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;

    const fakeScan = (p: string): Finding[] => {
      if (p === toolFilePath) {
        return [
          {
            RuleID: 'tool-rule',
            StartLine: 1,
            Match: 'tool-secret-value',
            StartColumn: 13,
            EndColumn: 29,
            File: p,
            Fingerprint: 'fp-tool',
          },
        ];
      }
      return [];
    };

    cmdRedact({ id: 'sess-toolresult' }, () => farFuture, fakeScan);

    const { readFileSync: realRead } = await import('node:fs');
    const toolContent = realRead(toolFilePath, 'utf8');
    expect(toolContent).toContain('[REDACTED:tool-rule]');
    expect(toolContent).not.toContain('tool-secret-value');
    expect(backupSpy).toHaveBeenCalledOnce();
    expect(backupSpy.mock.calls[0][0]).toBe(toolFilePath);
  });

  it('dry-run lists every dirty file path and finding lines, not just main', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sess-dry-multi.jsonl');
    writeFileSync(transcriptPath, '{"text":"clean-main"}\n');

    const sessionDir = join(projectsDir, 'sess-dry-multi');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"agent-secret"}\n');

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-fixed' };
    });

    const { cmdRedact } = await import('./commands.redact.ts');
    const farFuture = Date.now() + 10 * 60 * 1000;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const fakeScan = (p: string): Finding[] => {
      if (p === agentPath) {
        return [
          {
            RuleID: 'agent-rule',
            StartLine: 1,
            Match: 'agent-secret',
            StartColumn: 9,
            EndColumn: 21,
            File: p,
            Fingerprint: 'fp-agent',
          },
        ];
      }
      return [];
    };

    cmdRedact({ id: 'sess-dry-multi', dryRun: true }, () => farFuture, fakeScan);

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Dry-run output must mention the agent file path, not just main.
    expect(printed).toContain('agent-1.jsonl');
    expect(printed).toContain('agent-rule');
    // The main transcript path should NOT appear (it's clean).
    expect(printed).not.toContain('sess-dry-multi.jsonl');
  });

  it('"no findings" message fires only when main AND all agents are clean', async () => {
    const { transcriptPath, farFuture } = makeTestTranscript(
      testHome,
      'sess-allclean',
      '{"text":"clean"}\n',
    );
    // The session dir and subagents do not exist -> agents list is empty.
    expect(transcriptPath).toContain('sess-allclean');

    const { cmdRedact } = await import('./commands.redact.ts');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Scan returns [] for every path (both main and non-existent agents).
    cmdRedact(
      { id: 'sess-allclean' },
      () => farFuture,
      () => [],
    );

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('no findings');
    expect(printed).toContain('sess-allclean');
  });
});
