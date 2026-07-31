import { describe, expect, it } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import { alignFindingSpan, shannonEntropy } from './commands.push.recovery.span-align.ts';

/** A 40-char hex fixture, named so it does not read as a real credential. */
const HEX_FIXTURE = '585750b45ef08fd246ed5bf53d046c27c973a4d6';

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    RuleID: 'github-pat',
    File: 'shared/projects/p/abc123.jsonl',
    StartLine: 1,
    StartColumn: 1,
    EndColumn: 1,
    Match: '',
    Fingerprint: 'fp',
    ...overrides,
  };
}

/** Align a finding against a line given as a string. */
function align(finding: Finding, line: string) {
  return alignFindingSpan(finding, Buffer.from(line, 'utf8'));
}

/**
 * Build a finding whose reported columns are shifted by `shift`, simulating
 * the gitleaks off-by-one, for a secret at a known position in `line`.
 */
function shiftedFinding(line: string, secret: string, shift: number, extra: Partial<Finding> = {}) {
  const trueStart = Buffer.from(line, 'utf8').indexOf(Buffer.from(secret, 'utf8'));
  const width = Buffer.byteLength(secret, 'utf8');
  return makeFinding({
    Match: 'REDACTED',
    StartColumn: trueStart + 1 + shift,
    EndColumn: trueStart + width + shift,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  it('reports 0 bits for an empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('reports 1 bit for two equally frequent characters', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1, 10);
  });

  it('reports 0 bits for a single repeated character', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Column correction: the defect this module exists for
// ---------------------------------------------------------------------------

describe('alignFindingSpan - gitleaks column correction', () => {
  it('recovers the true span when the reported columns are one byte high', () => {
    const line = `  near:  ...${HEX_FIXTURE}`;
    const result = align(shiftedFinding(line, HEX_FIXTURE, 1), line);
    expect(result?.value).toBe(HEX_FIXTURE);
  });

  it('recovers the true span when the reported columns are correct', () => {
    const line = `  near:  ...${HEX_FIXTURE}`;
    const result = align(shiftedFinding(line, HEX_FIXTURE, 0), line);
    expect(result?.value).toBe(HEX_FIXTURE);
  });

  it('recovers the true span when the reported columns are one byte low', () => {
    // The correction is symmetric: nothing encodes which way gitleaks errs.
    const line = `  near:  ...${HEX_FIXTURE}  trailing`;
    const result = align(shiftedFinding(line, HEX_FIXTURE, -1), line);
    expect(result?.value).toBe(HEX_FIXTURE);
  });

  it('recovers the true span across multi-byte text on the same line', () => {
    // Columns are BYTE offsets, so a UTF-16 slice would land mid-secret.
    const line = `  h${'é'.repeat(20)}llo ...${HEX_FIXTURE}`;
    const result = align(shiftedFinding(line, HEX_FIXTURE, 1), line);
    expect(result?.value).toBe(HEX_FIXTURE);
  });

  it('reports the value start so the caller can slice the label text', () => {
    const label = '  near:  ...';
    const line = `${label}${HEX_FIXTURE}`;
    const result = align(shiftedFinding(line, HEX_FIXTURE, 1), line);
    expect(result?.valueStart).toBe(label.length);
  });
});

// ---------------------------------------------------------------------------
// Redaction templates
// ---------------------------------------------------------------------------

describe('alignFindingSpan - redaction template', () => {
  it('extracts the secret from between the template halves', () => {
    const line = `    const secret = '${HEX_FIXTURE}'`;
    const finding = shiftedFinding(line, `${HEX_FIXTURE}'`, 1, {
      Match: "REDACTED'",
    });
    const result = align(finding, line);
    expect(result?.value).toBe(HEX_FIXTURE);
    expect(result?.exact).toBe(true);
  });

  it('returns null when no shift produces a span carrying the template prefix', () => {
    // The template says the match opens with `token=`, but the line does not,
    // so every shift contradicts the report and none is trusted.
    const line = `xxxxxx${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: 'token=REDACTED',
      StartColumn: 1,
      EndColumn: 6 + HEX_FIXTURE.length,
    });
    expect(align(finding, line)).toBeNull();
  });

  it('treats an unredacted Match as a literal the span must reproduce exactly', () => {
    const line = `label: ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: HEX_FIXTURE,
      StartColumn: 8,
      EndColumn: 47,
    });
    const result = align(finding, line);
    expect(result?.value).toBe(HEX_FIXTURE);
    // The whole match is the value, so gitleaks' entropy does not describe it.
    expect(result?.exact).toBe(false);
  });

  it('returns null when Match is empty, leaving nothing to verify against', () => {
    const line = `label: ${HEX_FIXTURE}`;
    expect(align(makeFinding({ StartColumn: 8, EndColumn: 47 }), line)).toBeNull();
  });

  it('returns null when the template leaves no room for a value', () => {
    const line = 'ab';
    const finding = makeFinding({ Match: 'abREDACTED', StartColumn: 1, EndColumn: 2 });
    expect(align(finding, line)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bounds and token boundaries
// ---------------------------------------------------------------------------

describe('alignFindingSpan - bounds and token boundaries', () => {
  it('returns null when every candidate runs past the end of the line', () => {
    const line = 'short';
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: 1, EndColumn: 40 });
    expect(align(finding, line)).toBeNull();
  });

  it('aligns a secret that starts at the first byte of the line', () => {
    const line = `${HEX_FIXTURE} trailing`;
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: 2, EndColumn: 41 });
    const result = align(finding, line);
    expect(result?.value).toBe(HEX_FIXTURE);
    expect(result?.start).toBe(0);
  });

  it('rejects a candidate whose start edge cuts a word run in half', () => {
    // A one-byte shift into the secret leaves word bytes on both sides of the
    // start edge, which no gitleaks rule can produce.
    const line = `..${HEX_FIXTURE}..`;
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: 4, EndColumn: 43 });
    const result = align(finding, line);
    expect(result?.value).toBe(HEX_FIXTURE);
  });

  it('returns null when no shift produces a clean pair of edges', () => {
    const line = 'aaaaaaaaaaaaaaaa';
    const finding = makeFinding({ Match: 'REDACTED', StartColumn: 4, EndColumn: 9 });
    expect(align(finding, line)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unredacted reports: the Secret literal short-circuits the search
// ---------------------------------------------------------------------------

describe('alignFindingSpan - Secret literal', () => {
  it('locates Finding.Secret directly, ignoring the reported columns', () => {
    const line = `label: ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: `label: ${HEX_FIXTURE}`,
      Secret: HEX_FIXTURE,
      StartColumn: 999,
      EndColumn: 9999,
    });
    const result = align(finding, line);
    expect(result?.value).toBe(HEX_FIXTURE);
    expect(result?.valueStart).toBe('label: '.length);
    expect(result?.exact).toBe(true);
  });

  it('picks the occurrence nearest the reported column when the value repeats', () => {
    const line = `${HEX_FIXTURE} and ${HEX_FIXTURE}`;
    const second = line.lastIndexOf(HEX_FIXTURE);
    const finding = makeFinding({
      Match: HEX_FIXTURE,
      Secret: HEX_FIXTURE,
      StartColumn: second + 2,
      EndColumn: second + 41,
    });
    expect(align(finding, line)?.start).toBe(second);
  });

  it('keeps the earlier occurrence when the reported column points at it', () => {
    const line = `${HEX_FIXTURE} and ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: HEX_FIXTURE,
      Secret: HEX_FIXTURE,
      StartColumn: 2,
      EndColumn: 41,
    });
    expect(align(finding, line)?.start).toBe(0);
  });

  it('ignores a redacted Secret, which carries no value to locate', () => {
    const line = `label: ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: 'REDACTED',
      Secret: 'REDACTED',
      StartColumn: 8,
      EndColumn: 47,
    });
    expect(align(finding, line)?.value).toBe(HEX_FIXTURE);
  });

  it('ignores an empty Secret', () => {
    const line = `label: ${HEX_FIXTURE}`;
    const finding = makeFinding({ Match: 'REDACTED', Secret: '', StartColumn: 8, EndColumn: 47 });
    expect(align(finding, line)?.value).toBe(HEX_FIXTURE);
  });

  it('falls through when Finding.Secret does not appear on the line at all', () => {
    const line = `label: ${HEX_FIXTURE}`;
    const finding = makeFinding({
      Match: 'REDACTED',
      Secret: 'not-on-this-line',
      StartColumn: 8,
      EndColumn: 47,
    });
    expect(align(finding, line)?.value).toBe(HEX_FIXTURE);
  });
});

// ---------------------------------------------------------------------------
// Entropy tiebreaker
// ---------------------------------------------------------------------------

describe('alignFindingSpan - entropy tiebreaker', () => {
  // Every third byte is a hyphen, so several shifts produce equally clean
  // token edges and the other oracles cannot separate them.
  const ambiguous = 'a-b-c-d-e-f';

  /** Three-byte window over `ambiguous` whose reported start is deliberately ambiguous. */
  const windowFinding = (extra: Partial<Finding> = {}) =>
    makeFinding({ Match: 'REDACTED', StartColumn: 1, EndColumn: 3, ...extra });

  it('picks the single candidate whose value matches the reported entropy', () => {
    // '-b-' is the only 3-byte window here with two of one character.
    const result = align(windowFinding({ Entropy: shannonEntropy('-b-') }), ambiguous);
    expect(result?.value).toBe('-b-');
  });

  it('returns null when several candidates match the reported entropy', () => {
    // Both 'a-b' and 'b-c' hold three distinct characters.
    expect(align(windowFinding({ Entropy: shannonEntropy('a-b') }), ambiguous)).toBeNull();
  });

  it('returns null when no candidate matches the reported entropy', () => {
    expect(align(windowFinding({ Entropy: 12 }), ambiguous)).toBeNull();
  });

  it('returns null when the report carries no entropy to break the tie with', () => {
    expect(align(windowFinding(), ambiguous)).toBeNull();
  });

  it('returns null when the reported entropy is zero', () => {
    expect(align(windowFinding({ Entropy: 0 }), ambiguous)).toBeNull();
  });

  it('declines to break a tie on a multi-line match', () => {
    // The reported entropy covers lines this one cannot see.
    const finding = windowFinding({
      Entropy: shannonEntropy('-b-'),
      StartLine: 1,
      EndLine: 4,
    });
    expect(align(finding, ambiguous)).toBeNull();
  });

  it('declines to break a tie between unredacted matches, whose values are wider than the secret', () => {
    const line = '-.-.';
    const finding = makeFinding({
      Match: '-.',
      StartColumn: 1,
      EndColumn: 2,
      Entropy: shannonEntropy('-.'),
    });
    expect(align(finding, line)).toBeNull();
  });
});
