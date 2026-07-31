import { describe, expect, it } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import {
  buildPromptHeader,
  groupFindingsForPrompt,
  renderFindingBlock,
  sharedFingerprintPeers,
} from './commands.push.recovery.display.ts';
import {
  classifyCharset,
  describeSecret,
  formatNear,
  resolveSecretContext,
} from './commands.push.recovery.secret-shape.ts';

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
    EndLine: number;
    Secret: string;
    Entropy: number;
  }> = {},
): Finding {
  return {
    RuleID: overrides.RuleID ?? 'create-github-app-token',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    EndLine: overrides.EndLine,
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

describe('resolveSecretContext - redacted-template alignment', () => {
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

describe('resolveSecretContext - Match is exactly REDACTED', () => {
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

describe('resolveSecretContext - reported columns are one byte high', () => {
  // gitleaks reports its columns one higher than the true byte position for
  // any finding after the first line of a file. Slicing at the reported column
  // dropped the secret's first character into the label text, so the value
  // rendered a character short and the label gained a doubled character at the
  // seam.
  const shifted = (line: string, secret: string, match: string) => {
    const full = match.replace('REDACTED', secret);
    const start = line.indexOf(full);
    return makeFinding({
      Match: match,
      StartLine: 2,
      // Both columns one higher than the truth, exactly as gitleaks reports
      // them after the first line of a file.
      StartColumn: start + 2,
      EndColumn: start + full.length + 1,
    });
  };

  it('reports the full secret length rather than one character short', () => {
    const line = `  near:  ...${HEX_FIXTURE}`;
    const result = resolveSecretContext(shifted(line, HEX_FIXTURE, 'REDACTED'), () => line);
    expect(result.value).toBe(HEX_FIXTURE);
  });

  it('does not double the character at the label seam', () => {
    const label = `    const secret = '`;
    const line = `${label}${HEX_FIXTURE}'`;
    const finding = shifted(line, HEX_FIXTURE, `secret = 'REDACTED'`);
    const result = resolveSecretContext(finding, () => line);
    expect(result.value).toBe(HEX_FIXTURE);
    expect(result.near).toBe(label);
    expect(result.near).not.toContain('ssecret');
  });
});

describe('resolveSecretContext - the span cannot be verified against the line', () => {
  it('emits no value and falls back to the template label, never a line-derived lead', () => {
    // The template says the match opens with `token=`, the line says otherwise,
    // so the reported columns are not trusted for either field. `near` comes
    // from the finding's own Match, which needs no column arithmetic.
    const line = `some other text ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: 'token=REDACTED',
      StartColumn: 1,
      EndColumn: 6 + HEX_FIXTURE.length,
    });

    const result = resolveSecretContext(finding, () => line);

    expect(result.value).toBeNull();
    expect(result.near).toBe('token=');
  });

  it('renders neither a value: nor a near: line when the template carries no label', () => {
    const line = `some other text ${HEX_FIXTURE}`;
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: 400, EndColumn: 500 });

    const lines = renderFindingBlock(finding, () => line);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('  file:  ');
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

describe('groupFindingsForPrompt', () => {
  /** A line carrying the same value twice, at 1-indexed byte columns 1 and 51. */
  const twiceLine = `${HEX_FIXTURE} padding padding ${HEX_FIXTURE}`;

  it('groups two findings sharing a fingerprint AND a value, even at different columns', () => {
    // Match carries the redaction token, the shape a real `--redact` report
    // has: an empty Match offers nothing to verify the span against, so it
    // resolves to no value and keys off findingKey instead.
    const at = (col: number) =>
      makeFinding({
        Fingerprint: 'fp-a',
        StartColumn: col,
        EndColumn: col + 39,
        Match: 'REDACTED',
      });
    const groups = groupFindingsForPrompt(
      [at(1), at(twiceLine.indexOf(HEX_FIXTURE, 1) + 1)],
      () => twiceLine,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('does NOT merge two DIFFERENT secrets that share a fingerprint on one line', () => {
    // A gitleaks fingerprint is file:rule:startline with no column, so two
    // distinct secrets on one line collide. Merging them would hide the
    // second and apply one answer to both.
    const other = 'a'.repeat(40);
    const line = `${HEX_FIXTURE} and also ${other}`;
    const f1 = makeFinding({
      Fingerprint: 'fp-a',
      StartColumn: 1,
      EndColumn: 40,
      Match: 'REDACTED',
    });
    const f2 = makeFinding({
      Fingerprint: 'fp-a',
      StartColumn: 51,
      EndColumn: 90,
      Match: 'REDACTED',
    });
    const groups = groupFindingsForPrompt([f1, f2], () => line);
    expect(groups).toHaveLength(2);
  });

  it('produces two groups, in first-appearance order, for two distinct fingerprints', () => {
    const f1 = makeFinding({ Fingerprint: 'fp-a' });
    const f2 = makeFinding({ Fingerprint: 'fp-b' });
    const groups = groupFindingsForPrompt([f1, f2], nullReader);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([f1]);
    expect(groups[1]).toEqual([f2]);
  });

  it('keys an empty-Fingerprint finding off findingKey, so two do not merge at different columns', () => {
    const f1 = makeFinding({ Fingerprint: '', StartColumn: 1 });
    const f2 = makeFinding({ Fingerprint: '', StartColumn: 20 });
    const groups = groupFindingsForPrompt([f1, f2], nullReader);
    expect(groups).toHaveLength(2);
  });

  it('keys an unresolvable-value finding off findingKey rather than merging on assumption', () => {
    const f1 = makeFinding({ Fingerprint: 'fp-a', StartColumn: 1, Match: '' });
    const f2 = makeFinding({ Fingerprint: 'fp-a', StartColumn: 20, Match: '' });
    const groups = groupFindingsForPrompt([f1, f2], nullReader);
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// sharedFingerprintPeers
// ---------------------------------------------------------------------------

describe('sharedFingerprintPeers', () => {
  it('counts other groups sharing a fingerprint', () => {
    const groups = [
      [makeFinding({ Fingerprint: 'fp-a' })],
      [makeFinding({ Fingerprint: 'fp-a' })],
      [makeFinding({ Fingerprint: 'fp-b' })],
    ];
    expect(sharedFingerprintPeers(groups, 0)).toBe(1);
    expect(sharedFingerprintPeers(groups, 2)).toBe(0);
  });

  it('reports no peers for an empty fingerprint', () => {
    const groups = [[makeFinding({ Fingerprint: '' })], [makeFinding({ Fingerprint: '' })]];
    expect(sharedFingerprintPeers(groups, 0)).toBe(0);
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
    const shortValue = 'abcXYZ789012'; // 12 chars, below MIN_ELIDE_LEN
    const prefix = 'label: ';
    const line = `${prefix}${shortValue}`;
    const finding = makeFinding({
      Match: `${prefix}${shortValue}`,
      Secret: shortValue,
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

// ---------------------------------------------------------------------------
// Disclosure regressions
// ---------------------------------------------------------------------------

describe('disclosure regressions', () => {
  /** A PAT-shaped fixture assembled at runtime so the literal does not sit in the source. */
  const PAT_FIXTURE = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;

  it('does not leak the secret when multi-byte text precedes it on the line', () => {
    // gitleaks reports StartColumn/EndColumn as BYTE offsets. Slicing the
    // line as UTF-16 code units pushed the lead past the secret's own start
    // and rendered it verbatim on the near: line.
    const line = `${'é'.repeat(40)} ${PAT_FIXTURE}`;
    const byteStart = Buffer.from(`${'é'.repeat(40)} `, 'utf8').length + 1;
    const finding = makeFinding({
      RuleID: 'github-pat',
      StartColumn: byteStart,
      EndColumn: byteStart + PAT_FIXTURE.length - 1,
      Match: 'REDACTED',
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).not.toContain(PAT_FIXTURE);
  });

  it('does not leak a neighbouring secret through the near: line', () => {
    const other = `ghp_${'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'}`;
    const line = `${other} and also ${PAT_FIXTURE}`;
    const finding = makeFinding({
      RuleID: 'github-pat',
      StartColumn: line.indexOf(PAT_FIXTURE) + 1,
      EndColumn: line.indexOf(PAT_FIXTURE) + PAT_FIXTURE.length,
      Match: 'REDACTED',
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).not.toContain(other);
    expect(rendered).not.toContain(PAT_FIXTURE);
  });

  it('keeps a hyphenated label on the near: line while eliding token-shaped runs', () => {
    const line = `actions/create-github-app-token v3 -> ${HEX_FIXTURE} `;
    const finding = makeFinding({
      StartColumn: 1,
      EndColumn: line.length,
      Match: `actions/create-github-app-token v3 -> REDACTED `,
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).toContain('create-github-app-token');
    expect(rendered).not.toContain(HEX_FIXTURE);
  });

  it('warns when an Allow would also suppress another distinct secret', () => {
    const group = [makeFinding({ Fingerprint: 'fp-a' })];
    const header = buildPromptHeader(group, 1, 2, nullReader, 1);
    expect(header).toContain('Allow also suppresses 1 other distinct secret');
  });

  it('pluralises the shared-fingerprint warning', () => {
    const group = [makeFinding({ Fingerprint: 'fp-a' })];
    expect(buildPromptHeader(group, 1, 3, nullReader, 2)).toContain('2 other distinct secrets');
  });

  it('omits the warning when no other group shares the fingerprint', () => {
    const group = [makeFinding({ Fingerprint: 'fp-a' })];
    expect(buildPromptHeader(group, 1, 1, nullReader, 0)).not.toContain('warn:');
  });
});

// ---------------------------------------------------------------------------
// Entropy provenance
// ---------------------------------------------------------------------------

describe('entropy provenance', () => {
  it('quotes entropy when the rendered value IS the secret', () => {
    const prefix = 'label: ';
    const line = `${prefix}${HEX_FIXTURE} `;
    const finding = makeFinding({
      Match: `${prefix}REDACTED `,
      StartColumn: 1,
      EndColumn: line.length,
      Entropy: 3.62,
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).toContain('entropy 3.62');
  });

  it('omits entropy when the value fell back to the whole match span', () => {
    // gitleaks computes Entropy on the real secret. On the fallback path the
    // rendered value is the whole span, so the two describe different
    // strings and pairing them would misreport what is on screen.
    // Assembled, not written contiguously: a literal PEM header in the source
    // trips this repo's own gitleaks gate.
    const line = `-----BEGIN ${'PRIVATE'} KEY-----`;
    const finding = makeFinding({
      RuleID: 'private-key',
      Match: line,
      StartColumn: 1,
      EndColumn: line.length,
      Entropy: 4.2,
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).toContain('value:');
    expect(rendered).not.toContain('entropy');
  });
});

// ---------------------------------------------------------------------------
// Neighbouring-secret excision
// ---------------------------------------------------------------------------

describe('neighbouring secret excision', () => {
  // Shape cannot decide which text is a secret: a hyphenated label and a
  // hyphenated passphrase look identical, and a short secret looks like a
  // short word. Every shape below defeated the earlier shape heuristic, so
  // the control blanks other findings' byte spans by position.
  const shapes: [string, string][] = [
    ['letters only, above the elision gate', 'QzWxEcRvTyUiOpAsDfGh'],
    ['mixed but below the elision gate', 'aB3dE7gH1jK5mN9'],
    ['letters and hyphens, label-shaped', 'zZ-xX-cC-vV-bB-nN-mM-qQ'],
    ['mixed alphanumeric', 'A1b2C3d4E5f6G7h8I9j0K1'],
  ];

  for (const [name, neighbour] of shapes) {
    it(`excises a neighbouring secret that is ${name}`, () => {
      const line = `{"pw":"${neighbour}","tok":"${HEX_FIXTURE}"}`;
      const span = (needle: string) =>
        makeFinding({
          StartColumn: line.indexOf(needle) + 1,
          EndColumn: line.indexOf(needle) + needle.length,
          Match: 'REDACTED',
        });
      const rendered = renderFindingBlock(span(HEX_FIXTURE), () => line, [span(neighbour)]).join(
        '\n',
      );
      expect(rendered).not.toContain(neighbour);
    });
  }

  it('ignores a sibling whose own value cannot be resolved', () => {
    // An unresolvable sibling contributes nothing to excise; it must not
    // blank the label or throw.
    const line = `label: ${HEX_FIXTURE}`;
    const target = makeFinding({
      StartColumn: line.indexOf(HEX_FIXTURE) + 1,
      EndColumn: line.length,
      Match: 'REDACTED',
    });
    const unresolvable = makeFinding({ Match: '', StartColumn: 1, EndColumn: 0 });
    const rendered = renderFindingBlock(target, () => line, [unresolvable]).join('\n');
    expect(rendered).toContain('label:');
  });

  it('masks the protruding head of a sibling that encloses the finding', () => {
    // Two rules can match nested spans on one line: a broad rule enclosing a
    // narrow one starts to the LEFT of the finding, and skipping it wholesale
    // left that prefix in the label.
    const enclosing = 'QzWxEcRvTyUiOpAsDfGhJkLp';
    const inner = HEX_FIXTURE;
    const line = `{"cfg":"${enclosing} wraps ${inner}"}`;
    const narrow = makeFinding({
      StartColumn: line.indexOf(inner) + 1,
      EndColumn: line.indexOf(inner) + inner.length,
      Match: 'REDACTED',
    });
    const broad = makeFinding({
      StartColumn: line.indexOf(enclosing) + 1,
      EndColumn: line.indexOf(inner) + inner.length,
      Match: 'REDACTED',
    });
    const rendered = renderFindingBlock(narrow, () => line, [broad]).join('\n');
    expect(rendered).not.toContain(enclosing);
    expect(rendered).not.toContain(inner);
  });

  it('masks a sibling that sits entirely after the finding', () => {
    const trailing = 'QzWxEcRvTyUiOpAsDfGhJkLp';
    const line = `${HEX_FIXTURE} then ${trailing}`;
    const target = makeFinding({
      StartColumn: 1,
      EndColumn: HEX_FIXTURE.length,
      Match: 'REDACTED',
    });
    const after = makeFinding({
      StartColumn: line.indexOf(trailing) + 1,
      EndColumn: line.indexOf(trailing) + trailing.length,
      Match: 'REDACTED',
    });
    const rendered = renderFindingBlock(target, () => line, [after]).join('\n');
    expect(rendered).not.toContain(trailing);
  });

  it('still describes the finding when a sibling covers exactly its own span', () => {
    // An overlapping sibling must never blank the value under triage.
    const line = `label: ${HEX_FIXTURE}`;
    const start = line.indexOf(HEX_FIXTURE) + 1;
    const target = makeFinding({
      StartColumn: start,
      EndColumn: line.length,
      Match: 'REDACTED',
    });
    const overlapping = makeFinding({
      StartColumn: start,
      EndColumn: line.length,
      Match: 'REDACTED',
    });
    const rendered = renderFindingBlock(target, () => line, [overlapping]).join('\n');
    expect(rendered).toContain('5857...a4d6');
    expect(rendered).toContain('label:');
  });

  it('leaves the label intact when no sibling finding covers it', () => {
    const line = `actions/create-github-app-token v3 -> ${HEX_FIXTURE} `;
    const finding = makeFinding({
      StartColumn: 1,
      EndColumn: line.length,
      Match: 'actions/create-github-app-token v3 -> REDACTED ',
    });
    const rendered = renderFindingBlock(finding, () => line, []).join('\n');
    expect(rendered).toContain('create-github-app-token');
  });
});

// ---------------------------------------------------------------------------
// Multi-line matches
// ---------------------------------------------------------------------------

describe('multi-line matches', () => {
  it('omits entropy when the match spans more than one line', () => {
    // Only part of a PEM block is on this line, so the recovered span is a
    // fragment while gitleaks' entropy describes the whole secret.
    // Assembled, not written contiguously: a literal PEM header in the source
    // trips this repo's own gitleaks gate.
    const line = `-----BEGIN ${'PRIVATE'} KEY-----`;
    const finding = makeFinding({
      RuleID: 'private-key',
      Match: 'REDACTED',
      StartColumn: 1,
      EndColumn: line.length,
      StartLine: 1,
      EndLine: 9,
      Entropy: 5.1,
    });
    const rendered = renderFindingBlock(finding, () => line).join('\n');
    expect(rendered).toContain('value:');
    expect(rendered).not.toContain('entropy');
  });
});
