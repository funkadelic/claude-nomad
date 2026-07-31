import { describe, expect, it } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import {
  buildPromptHeader,
  classifyCharset,
  describeSecret,
  formatNear,
  groupFindingsByFingerprint,
  renderFindingBlock,
  resolveSecretContext,
} from './commands.push.recovery.display.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A 40-char hex fixture, named so it does not read as a real credential next to a variable called SECRET. */
const HEX_FIXTURE = '585750b45ef08fd246ed5bf53d046c27c973a4d6';

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
    Secret: string;
    Entropy: number;
  }> = {},
): Finding {
  return {
    RuleID: overrides.RuleID ?? 'create-github-app-token',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 1,
    EndColumn: overrides.EndColumn ?? 1,
    Match: overrides.Match ?? '',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:rule:1',
    Secret: overrides.Secret,
    Entropy: overrides.Entropy,
  };
}

/** Injected readLine that always returns null. */
const nullReader = (_file: string, _line: number): string | null => null;

// ---------------------------------------------------------------------------
// classifyCharset
// ---------------------------------------------------------------------------

describe('classifyCharset', () => {
  it('classifies a hex string as hex', () => {
    expect(classifyCharset('585750b4')).toBe('hex');
  });

  it('classifies a mixed-case alphanumeric string as alphanumeric', () => {
    expect(classifyCharset('abcXYZ789')).toBe('alphanumeric');
  });

  it('classifies a hyphen/underscore string as base64url', () => {
    expect(classifyCharset('ab-c_1Z')).toBe('base64url');
  });

  it('classifies a string with other punctuation as mixed', () => {
    expect(classifyCharset('a.b!c')).toBe('mixed');
  });
});

// ---------------------------------------------------------------------------
// describeSecret
// ---------------------------------------------------------------------------

describe('describeSecret', () => {
  it('describes a 40-char hex value with a head/tail fragment, char count, class, and entropy', () => {
    const result = describeSecret(HEX_FIXTURE, 3.6218);
    expect(result).toContain('5857...a4d6');
    expect(result).toContain('40 chars');
    expect(result).toContain('hex');
    expect(result).toContain('entropy 3.62');
  });

  it('describes a 12-char value with no fragment or separator', () => {
    const result = describeSecret('abcXYZ789012');
    expect(result).toContain('12 chars');
    expect(result).toContain('alphanumeric');
    expect(result).not.toContain('...');
  });

  it('omits the entropy clause when entropy is undefined', () => {
    const result = describeSecret('abcXYZ789012');
    expect(result).not.toContain('entropy');
  });

  it('omits the entropy clause when entropy is 0', () => {
    const result = describeSecret('abcXYZ789012', 0);
    expect(result).not.toContain('entropy');
  });
});

// ---------------------------------------------------------------------------
// resolveSecretContext
// ---------------------------------------------------------------------------

describe('resolveSecretContext - redacted-template alignment (F1/F2)', () => {
  it('describes the real secret and near ends with the label text, with no secret leakage', () => {
    const prefix = 'create-github-app-token  v3 -> ';
    const line = `${prefix}${HEX_FIXTURE} `;
    const finding = makeFinding({
      Match: `${prefix}REDACTED `,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const result = resolveSecretContext(finding, reader);

    expect(result.value).toBe(HEX_FIXTURE);
    expect(result.near).toBe(prefix);
    expect(result.near).not.toContain(HEX_FIXTURE);
  });
});

describe('resolveSecretContext - Match is exactly REDACTED (F4)', () => {
  it('treats the whole clamped raw span as the secret', () => {
    const line = `prefix ${HEX_FIXTURE} suffix`;
    const startCol = 'prefix '.length + 1;
    const endCol = 'prefix '.length + HEX_FIXTURE.length;
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: startCol, EndColumn: endCol });
    const reader = (_file: string, _line: number): string | null => line;

    const result = resolveSecretContext(finding, reader);

    expect(result.value).toBe(HEX_FIXTURE);
  });
});

describe('resolveSecretContext - readLine returns null with a redacted Match', () => {
  it('returns a null value and the label prefix as near', () => {
    const prefix = 'create-github-app-token  v3 -> ';
    const finding = makeFinding({ Match: `${prefix}REDACTED ` });

    const result = resolveSecretContext(finding, nullReader);

    expect(result.value).toBeNull();
    expect(result.near).toBe(prefix);
  });
});

describe('resolveSecretContext - unredacted Secret present in the span', () => {
  it('describes Finding.Secret and near is everything before it', () => {
    const prefix = 'label: ';
    const line = `${prefix}${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: `${prefix}${HEX_FIXTURE}`,
      Secret: HEX_FIXTURE,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const result = resolveSecretContext(finding, reader);

    expect(result.value).toBe(HEX_FIXTURE);
    expect(result.near).toBe(prefix);
  });
});

describe('resolveSecretContext - readLine null and Match empty', () => {
  it('returns null for both value and near', () => {
    const finding = makeFinding({ Match: '' });

    const result = resolveSecretContext(finding, nullReader);

    expect(result.value).toBeNull();
    expect(result.near).toBeNull();
  });
});

describe('resolveSecretContext - final fallback with a readable line, no REDACTED template, no Secret', () => {
  it('treats the whole clamped raw span as the secret', () => {
    const prefix = 'label: ';
    const line = `${prefix}${HEX_FIXTURE}`;
    const startCol = prefix.length + 1;
    const endCol = prefix.length + HEX_FIXTURE.length;
    // Match carries no REDACTED literal and no Secret field is set, so
    // neither alignRedactedMatch nor the unredacted-Secret step applies.
    const finding = makeFinding({ Match: HEX_FIXTURE, StartColumn: startCol, EndColumn: endCol });
    const reader = (_file: string, _line: number): string | null => line;

    const result = resolveSecretContext(finding, reader);

    expect(result.value).toBe(HEX_FIXTURE);
    expect(result.near).toBe(prefix);
  });
});

// ---------------------------------------------------------------------------
// formatNear
// ---------------------------------------------------------------------------

describe('formatNear', () => {
  it('strips C0 control chars and DEL', () => {
    // eslint-disable-next-line no-control-regex
    const CTRL_REGEX = /[\x00-\x1f\x7f]/;
    const result = formatNear('prefix\x07\x00 label \x1b[31m');
    expect(result).not.toBeNull();
    expect(CTRL_REGEX.test(result!)).toBe(false);
  });

  it('prepends an ellipsis only when the pre-trim text exceeds the 40-char window', () => {
    const short = formatNear('short label');
    expect(short).not.toBeNull();
    expect(short!.startsWith('...')).toBe(false);

    const long = formatNear('A'.repeat(60));
    expect(long).not.toBeNull();
    expect(long!.startsWith('...')).toBe(true);
  });

  it('returns null when nothing remains after stripping and trimming', () => {
    expect(formatNear('')).toBeNull();
    expect(formatNear('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderFindingBlock
// ---------------------------------------------------------------------------

describe('renderFindingBlock', () => {
  it('always emits the file: line', () => {
    const finding = makeFinding({ Match: '' });
    const lines = renderFindingBlock(finding, nullReader);
    expect(lines[0]).toContain('  file:  ');
    expect(lines[0]).toContain(finding.File);
  });

  it('omits value: and near: when their source is null', () => {
    const finding = makeFinding({ Match: '' });
    const lines = renderFindingBlock(finding, nullReader);
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes('value:'))).toBe(false);
    expect(lines.some((l) => l.includes('near:'))).toBe(false);
  });

  it('emits value: and near: when both are resolvable', () => {
    const prefix = 'create-github-app-token  v3 -> ';
    const line = `${prefix}${HEX_FIXTURE} `;
    const finding = makeFinding({
      Match: `${prefix}REDACTED `,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const lines = renderFindingBlock(finding, reader);

    expect(lines.some((l) => l.startsWith('  value: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('  near:  '))).toBe(true);
    expect(lines.join('\n')).not.toContain(HEX_FIXTURE);
  });

  it('omits the session suffix for a flat <sid>.jsonl file, whose basename already names the session', () => {
    const finding = makeFinding({ File: 'shared/projects/p/abc123.jsonl', Match: '' });
    const lines = renderFindingBlock(finding, nullReader);
    expect(lines[0]).not.toContain('(session:');
  });

  it('keeps the session suffix for a nested subagent file, whose basename differs from the session id', () => {
    const finding = makeFinding({
      File: 'shared/projects/p/abc123/subagents/agent-1.jsonl',
      Match: '',
    });
    const lines = renderFindingBlock(finding, nullReader);
    expect(lines[0]).toContain('(session: abc123)');
  });

  it('keeps the session suffix for a non-.jsonl subtree file, whose basename is not the session id', () => {
    const finding = makeFinding({
      File: 'shared/projects/p/abc123/tool-results/x.txt',
      Match: '',
    });
    const lines = renderFindingBlock(finding, nullReader);
    expect(lines[0]).toContain('(session: abc123)');
  });
});

// ---------------------------------------------------------------------------
// groupFindingsByFingerprint
// ---------------------------------------------------------------------------

describe('groupFindingsByFingerprint', () => {
  it('groups two findings sharing a Fingerprint into one group, even at different columns', () => {
    const f1 = makeFinding({ Fingerprint: 'fp-a', StartColumn: 1 });
    const f2 = makeFinding({ Fingerprint: 'fp-a', StartColumn: 20 });
    const groups = groupFindingsByFingerprint([f1, f2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('produces two groups, in first-appearance order, for two distinct fingerprints', () => {
    const f1 = makeFinding({ Fingerprint: 'fp-a' });
    const f2 = makeFinding({ Fingerprint: 'fp-b' });
    const groups = groupFindingsByFingerprint([f1, f2]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([f1]);
    expect(groups[1]).toEqual([f2]);
  });

  it('keys an empty-Fingerprint finding off findingKey, so two do not merge at different columns', () => {
    const f1 = makeFinding({ Fingerprint: '', StartColumn: 1 });
    const f2 = makeFinding({ Fingerprint: '', StartColumn: 20 });
    const groups = groupFindingsByFingerprint([f1, f2]);
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildPromptHeader
// ---------------------------------------------------------------------------

describe('buildPromptHeader', () => {
  it('includes an occurrence/ignore-entry summary for a multi-member group', () => {
    const f1 = makeFinding({ Fingerprint: 'fp-a' });
    const f2 = makeFinding({ Fingerprint: 'fp-a' });
    const header = buildPromptHeader([f1, f2], 1, 2, nullReader);
    expect(header).toContain('Finding 1/2:');
    expect(header).toContain('2 occurrences, 1 ignore entry');
  });

  it('omits the occurrence/ignore-entry summary for a single-member group', () => {
    const f1 = makeFinding();
    const header = buildPromptHeader([f1], 1, 1, nullReader);
    expect(header).toContain('Finding 1/1:');
    expect(header).not.toContain('occurrence');
    expect(header).not.toContain('ignore entry');
  });

  it('offers [D]rop session only when the group resolves a session id', () => {
    const sessionFinding = makeFinding({ File: 'shared/projects/p/abc123.jsonl' });
    const withSession = buildPromptHeader([sessionFinding], 1, 1, nullReader);
    expect(withSession).toContain('[D]rop session');

    const skillFinding = makeFinding({ File: 'shared/skills/my-skill/SKILL.md' });
    const withoutSession = buildPromptHeader([skillFinding], 1, 1, nullReader);
    expect(withoutSession).not.toContain('[D]rop');
    expect(withoutSession).toContain('[R]edact  [A]llow  [S]kip (default)');
  });
});

// ---------------------------------------------------------------------------
// Disclosure guard: the raw secret never survives into rendered output
// ---------------------------------------------------------------------------

/**
 * Assert that `text` contains no contiguous substring of `secret` longer
 * than 4 characters (the head/tail fragment length). A head/tail fragment
 * built from 4-char pieces separated by a non-class separator cannot itself
 * carry a longer contiguous run of the original secret, so this is a
 * structural proof, not a spot check on one fragment shape.
 */
function assertNoLongContiguousRun(text: string, secret: string): void {
  for (let i = 0; i <= secret.length - 5; i++) {
    expect(text).not.toContain(secret.slice(i, i + 5));
  }
}

describe('disclosure guard - the full secret and long contiguous runs never appear in rendered output', () => {
  it('redacted-report fixture: no full secret, no run longer than 4 chars', () => {
    const prefix = 'create-github-app-token  v3 -> ';
    const line = `${prefix}${HEX_FIXTURE} `;
    const finding = makeFinding({
      Match: `${prefix}REDACTED `,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const rendered = renderFindingBlock(finding, reader).join('\n');

    expect(rendered).not.toContain(HEX_FIXTURE);
    assertNoLongContiguousRun(rendered, HEX_FIXTURE);
  });

  it('unredacted-Secret fixture: no full secret, no run longer than 4 chars', () => {
    const prefix = 'label: ';
    const line = `${prefix}${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: `${prefix}${HEX_FIXTURE}`,
      Secret: HEX_FIXTURE,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const rendered = renderFindingBlock(finding, reader).join('\n');

    expect(rendered).not.toContain(HEX_FIXTURE);
    assertNoLongContiguousRun(rendered, HEX_FIXTURE);
  });

  it('a sub-16-character secret renders the value: line with no fragment at all', () => {
    const secret = 'abcXYZ789012'; // 12 chars, below MIN_ELIDE_LEN
    const prefix = 'label: ';
    const line = `${prefix}${secret}`;
    const finding = makeFinding({
      Match: `${prefix}${secret}`,
      Secret: secret,
      StartColumn: 1,
      EndColumn: line.length,
    });
    const reader = (_file: string, _line: number): string | null => line;

    const lines = renderFindingBlock(finding, reader);
    const valueLine = lines.find((l) => l.startsWith('  value: '));

    expect(valueLine).toBeDefined();
    expect(valueLine).not.toContain('...');
    expect(valueLine).toContain('12 chars');
  });
});
