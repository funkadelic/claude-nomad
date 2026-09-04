/**
 * Unit coverage for `toFinding`, the report-entry normalizer that guards every
 * downstream consumer from a malformed gitleaks report. Kept in its own file
 * because `push-gitleaks.scan.test.ts` drives the module through `vi.doMock`
 * plus dynamic import, which a static import of the real module would fight.
 */

import { describe, expect, it } from 'vitest';

import { toFinding } from './gitleaks.scan.ts';

describe('toFinding', () => {
  it('defaults absent optional fields instead of leaving them undefined', () => {
    // Consumers dereference Match, Fingerprint and File directly. An entry
    // missing one used to surface as a TypeError inside the interactive
    // recovery menu, after remapPush had already mutated the repo.
    const result = toFinding({ RuleID: 'generic-api-key', File: 'a.jsonl', StartLine: 1 });
    expect(result).not.toBeNull();
    expect(result?.Match).toBe('');
    expect(result?.Fingerprint).toBe('');
    expect(result?.StartColumn).toBe(0);
    expect(result?.EndColumn).toBe(0);
  });

  it('preserves the optional Secret and Entropy fields when present', () => {
    const result = toFinding({
      RuleID: 'r',
      File: 'a.jsonl',
      StartLine: 1,
      Secret: 'REDACTED',
      Entropy: 3.62,
      Description: 'desc',
    });
    expect(result?.Secret).toBe('REDACTED');
    expect(result?.Entropy).toBeCloseTo(3.62);
    expect(result?.Description).toBe('desc');
  });

  it('drops a non-string Secret, Entropy or Description rather than trusting it', () => {
    const result = toFinding({
      RuleID: 'r',
      File: 'a.jsonl',
      StartLine: 1,
      Secret: 7,
      Entropy: 'high',
      Description: 3,
    });
    expect(result?.Secret).toBeUndefined();
    expect(result?.Entropy).toBeUndefined();
    expect(result?.Description).toBeUndefined();
  });

  it('rejects an entry with no File or no RuleID, which cannot form a fingerprint', () => {
    expect(toFinding({ RuleID: 'r', StartLine: 1 })).toBeNull();
    expect(toFinding({ File: 'a.jsonl', StartLine: 1 })).toBeNull();
  });

  it('rejects a non-object entry', () => {
    expect(toFinding(null)).toBeNull();
    expect(toFinding('a string')).toBeNull();
  });

  it('drops a non-finite EndLine or Entropy rather than passing Infinity through', () => {
    // The required numeric fields already go through a finite check; the
    // optional ones must match, or a report carrying 1e400 hands an Infinity
    // to every consumer.
    // Modelled the way it actually arrives: JSON.parse turns an out-of-range
    // literal into Infinity, so the report reaches the parser already non-finite.
    const entry: unknown = JSON.parse(
      '{"RuleID":"r","File":"a.jsonl","StartLine":1,"EndLine":1e400,"Entropy":1e400}',
    );
    const result = toFinding(entry);
    expect(result?.EndLine).toBeUndefined();
    expect(result?.Entropy).toBeUndefined();
  });

  it('coerces a non-finite number field to zero', () => {
    const result = toFinding({ RuleID: 'r', File: 'a.jsonl', StartLine: Number.NaN });
    expect(result?.StartLine).toBe(0);
  });
});
