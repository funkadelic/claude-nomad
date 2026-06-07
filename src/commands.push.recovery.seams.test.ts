import { describe, expect, it } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import { buildFindingContext, maskSecret } from './commands.push.recovery.seams.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(
  overrides: Partial<{
    RuleID: string;
    File: string;
    StartLine: number;
    StartColumn: number;
    EndColumn: number;
    Match: string;
    Fingerprint: string;
  }> = {},
): Finding {
  return {
    RuleID: overrides.RuleID ?? 'github-pat',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 1,
    EndColumn: overrides.EndColumn ?? 40,
    Match: overrides.Match ?? 'ghp_FAKESECRETVALUE1234567890ABCDEF',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    Description: 'GitHub PAT',
  };
}

/** Injected readLine that always returns null. */
const nullReader = (_file: string, _line: number): string | null => null;

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------

describe('maskSecret', () => {
  it('keeps 4 leading chars and appends 12 asterisks for a long secret', () => {
    const result = maskSecret('ghp_FAKESECRETVALUE1234567890ABCDEF');
    expect(result).toBe('ghp_************');
    expect(result.endsWith('************')).toBe(true);
    expect(result.startsWith('ghp_')).toBe(true);
  });

  it('keeps fewer chars when the secret is shorter than 4', () => {
    const result = maskSecret('ab');
    // Only 2 chars available, no out-of-range slice.
    expect(result).toBe('ab************');
    expect(() => maskSecret('ab')).not.toThrow();
  });

  it('returns the bare mask for an empty secret', () => {
    expect(maskSecret('')).toBe('************');
  });

  it('does not reveal full length (mask is always 12 asterisks regardless of secret length)', () => {
    const short = maskSecret('x');
    const long = maskSecret('x'.repeat(100));
    // Both end with the same 12-asterisk mask.
    expect(short.slice(-12)).toBe('************');
    expect(long.slice(-12)).toBe('************');
    // Output lengths differ only by the lead, not by secret length.
    expect(short.length).toBe(1 + 12);
    expect(long.length).toBe(4 + 12);
  });
});

// ---------------------------------------------------------------------------
// buildFindingContext - primary path (readLine returns a line)
// ---------------------------------------------------------------------------

describe('buildFindingContext - primary path', () => {
  const SECRET = 'ghp_FAKESECRETVALUE1234567890ABCDEF';
  // Line: "prefix_text SECRET suffix_text"
  //        123456789012345678901234567890123456789012345678901234567890
  // StartColumn=13 (1-indexed), EndColumn=13+len(SECRET)-1
  const prefix = 'prefix_text ';
  const suffix = ' suffix_text';
  const line = prefix + SECRET + suffix;
  const startCol = prefix.length + 1; // 13
  const endCol = prefix.length + SECRET.length; // 12 + 34 = 46

  const finding = makeFinding({ StartColumn: startCol, EndColumn: endCol, Match: SECRET });
  const reader = (_file: string, _line: number): string | null => line;

  it('excerpt contains the masked span and surrounding context', () => {
    const result = buildFindingContext(finding, reader);
    expect(result).not.toBeNull();
    expect(result).toContain('ghp_************');
    expect(result).toContain('prefix_text ');
    expect(result).toContain(' suffix_text');
  });

  it('does NOT contain the raw secret value in any output path', () => {
    const result = buildFindingContext(finding, reader);
    expect(result).not.toContain(SECRET);
  });
});

describe('buildFindingContext - truncation on both sides', () => {
  const SECRET = 'MYSECRET';
  // Build a line where both sides are longer than CONTEXT_WINDOW (40 chars).
  const prefix = 'A'.repeat(60);
  const suffix = 'B'.repeat(60);
  const line = prefix + SECRET + suffix;
  const startCol = prefix.length + 1;
  const endCol = prefix.length + SECRET.length;
  const finding = makeFinding({ StartColumn: startCol, EndColumn: endCol, Match: SECRET });
  const reader = (_file: string, _line: number): string | null => line;

  it('prepends and appends ellipsis when both sides are truncated', () => {
    const result = buildFindingContext(finding, reader);
    expect(result).not.toBeNull();
    expect(result!.startsWith('...')).toBe(true);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('does not contain the raw secret', () => {
    expect(buildFindingContext(finding, reader)).not.toContain(SECRET);
  });
});

describe('buildFindingContext - span at line start', () => {
  const SECRET = 'MYSECRET';
  const line = SECRET + ' rest of line';
  const finding = makeFinding({ StartColumn: 1, EndColumn: SECRET.length, Match: SECRET });
  const reader = (_file: string, _line: number): string | null => line;

  it('no leading ellipsis when span is at line start', () => {
    const result = buildFindingContext(finding, reader);
    expect(result).not.toBeNull();
    expect(result!.startsWith('...')).toBe(false);
    expect(result).toContain('MYSE************');
  });
});

// ---------------------------------------------------------------------------
// buildFindingContext - fallback path (readLine returns null)
// ---------------------------------------------------------------------------

describe('buildFindingContext - fallback path', () => {
  it('returns masked Match when readLine returns null and Match is non-empty', () => {
    const SECRET = 'ghp_FAKESECRETVALUE1234567890ABCDEF';
    const finding = makeFinding({ Match: SECRET });
    const result = buildFindingContext(finding, nullReader);
    expect(result).not.toBeNull();
    // Masked: first 4 chars + 12 asterisks.
    expect(result).toBe('ghp_************');
    // Raw secret must not appear.
    expect(result).not.toContain(SECRET);
  });

  it('returns null when readLine returns null and Match is empty', () => {
    const finding = makeFinding({ Match: '' });
    const result = buildFindingContext(finding, nullReader);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildFindingContext - control character stripping
// ---------------------------------------------------------------------------

describe('buildFindingContext - control character stripping', () => {
  // eslint-disable-next-line no-control-regex
  const CTRL_REGEX = /[\x00-\x1f\x7f]/;

  it('strips C0 control chars embedded in the source line', () => {
    // Line contains BEL, NUL, and ESC characters outside the secret span.
    const line = 'prefix\x07\x00 SECRET \x1b[31m suffix';
    const finding = makeFinding({ StartColumn: 16, EndColumn: 21, Match: 'SECRET' });
    const reader = (_f: string, _n: number): string | null => line;
    const result = buildFindingContext(finding, reader);
    expect(result).not.toBeNull();
    expect(CTRL_REGEX.test(result!)).toBe(false);
  });

  it('strips control chars from the masked Match fallback', () => {
    const finding = makeFinding({ Match: 'sec\x07ret' });
    const result = buildFindingContext(finding, nullReader);
    expect(result).not.toBeNull();
    expect(CTRL_REGEX.test(result!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFindingContext - out-of-range column guard
// ---------------------------------------------------------------------------

describe('buildFindingContext - out-of-range column guard', () => {
  it('does not throw when StartColumn exceeds the line length', () => {
    const line = 'short';
    const finding = makeFinding({ StartColumn: 9999, EndColumn: 99999, Match: 'fallback' });
    const reader = (_f: string, _n: number): string | null => line;
    expect(() => buildFindingContext(finding, reader)).not.toThrow();
  });

  it('clamps out-of-range columns and still returns an excerpt without throwing', () => {
    // StartColumn past end: clamped to len+1. The masked-span is empty and
    // the mask appends to the full prefix. The excerpt is non-empty so it is
    // returned (no fallback needed).
    const line = '     ';
    const finding = makeFinding({ StartColumn: 9999, EndColumn: 99999, Match: 'fallback-match' });
    const reader = (_f: string, _n: number): string | null => line;
    const result = buildFindingContext(finding, reader);
    // Must not throw and must not contain the raw Match value.
    expect(result).not.toContain('fallback-match');
  });
});
