import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { failGlyph, okGlyph } from './color.ts';

import type * as scanModule from './push-gitleaks.ts';
import type * as checksModule from './push-checks.ts';

/**
 * Build a minimal `Finding` for a session-path file so `partitionFindings`
 * routes it into the `bySession` bucket.
 *
 * @param sid - The session id embedded in the synthetic file path.
 * @returns A `Finding` whose `File` matches the session-path pattern.
 */
function sessionFinding(sid: string): scanModule.Finding {
  return {
    RuleID: 'generic-api-key',
    File: `shared/projects/foo/${sid}.jsonl`,
    StartLine: 1,
    StartColumn: 1,
    EndColumn: 10,
    Match: 'secret',
    Fingerprint: `fp-${sid}`,
  };
}

/**
 * Build a minimal `Finding` for a non-session file so `partitionFindings`
 * routes it into the `other` bucket (exercising the fallback count path).
 *
 * @returns A `Finding` whose `File` does NOT match the session-path pattern.
 */
function otherFinding(): scanModule.Finding {
  return {
    RuleID: 'generic-api-key',
    File: 'shared/other/file.txt',
    StartLine: 3,
    StartColumn: 1,
    EndColumn: 10,
    Match: 'secret',
    Fingerprint: 'fp-other',
  };
}

describe('push-leak-verdict: pure row + verdict builders', () => {
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('./push-checks.ts');
  });

  it('noLeaksRow embeds the ok glyph; failRow embeds the fail glyph', async () => {
    const { noLeaksRow, failRow } = await import('./push-leak-verdict.ts');
    expect(noLeaksRow()).toContain(okGlyph);
    expect(noLeaksRow()).toContain('no leaks');
    expect(failRow('boom')).toContain(failGlyph);
    expect(failRow('boom')).toContain('boom');
  });

  it('leakVerdictRow counts affected sessions when findings match the session path', async () => {
    const { leakVerdictRow } = await import('./push-leak-verdict.ts');
    const row = leakVerdictRow([sessionFinding('s1'), sessionFinding('s2')]);
    expect(row).toContain(failGlyph);
    expect(row).toContain('gitleaks detected secrets in 2 session transcript(s)');
  });

  it('leakVerdictRow falls back to the raw finding count when no session path matches', async () => {
    const { leakVerdictRow } = await import('./push-leak-verdict.ts');
    const row = leakVerdictRow([otherFinding(), otherFinding(), otherFinding()]);
    expect(row).toContain('gitleaks detected secrets in 3 session transcript(s)');
  });

  it('leakVerdictRow dedupes duplicate findings before counting sessions (count consistency)', async () => {
    // Defect #4: duplicate findings (same Fingerprint) must not inflate the
    // session count in the verdict row. Three copies of the same session finding
    // must report 1 session, not 3.
    const { leakVerdictRow } = await import('./push-leak-verdict.ts');
    const f = sessionFinding('sid-dup');
    const row = leakVerdictRow([f, f, f]);
    expect(row).toContain('gitleaks detected secrets in 1 session transcript(s)');
  });

  it('verdictFromFindings(null) is a non-leak scan-failed verdict and sets exitCode 1', async () => {
    const { verdictFromFindings } = await import('./push-leak-verdict.ts');
    const v = verdictFromFindings(null);
    expect(v.leak).toBe(false);
    expect(v.recovery).toBeNull();
    expect(v.verdictRow).toContain('scan failed, no parseable report');
    expect(v.findings).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('verdictFromFindings([]) is a clean no-leaks verdict and does not set exitCode 1', async () => {
    const { verdictFromFindings } = await import('./push-leak-verdict.ts');
    const v = verdictFromFindings([]);
    expect(v.leak).toBe(false);
    expect(v.recovery).toBeNull();
    expect(v.verdictRow).toContain('no leaks');
    expect(v.findings).toEqual([]);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it('verdictFromFindings(findings) is a leak verdict with recovery and sets exitCode 1', async () => {
    const { verdictFromFindings } = await import('./push-leak-verdict.ts');
    const f = sessionFinding('abc');
    const v = verdictFromFindings([f]);
    expect(v.leak).toBe(true);
    expect(v.verdictRow).toContain('gitleaks detected secrets in 1 session transcript(s)');
    expect(v.recovery ?? '').toContain('nomad drop-session abc');
    expect(v.findings).toEqual([f]);
    expect(process.exitCode).toBe(1);
  });

  it('verdictScanError is a non-leak ✗ verdict that sets exitCode 1', async () => {
    const { verdictScanError } = await import('./push-leak-verdict.ts');
    const v = verdictScanError('scan error (git or gitleaks not on PATH)');
    expect(v.leak).toBe(false);
    expect(v.recovery).toBeNull();
    expect(v.verdictRow).toContain('scan error');
    expect(v.findings).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe('push-leak-verdict: scanPushVerdict (real-push scan path)', () => {
  let originalExitCode: typeof process.exitCode;
  let errSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('./push-checks.ts');
  });

  it('returns a clean no-leaks verdict when the staged scan finds nothing', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: vi.fn((): scanModule.Finding[] | null => []) };
    });
    const { scanPushVerdict } = await import('./push-leak-verdict.ts');
    const v = scanPushVerdict('/repo');
    expect(v.leak).toBe(false);
    expect(v.recovery).toBeNull();
    expect(v.verdictRow).toContain('no leaks');
    expect(v.findings).toEqual([]);
  });

  it('returns a leak verdict (✗ row + recovery body) when the staged scan finds secrets', async () => {
    const f = sessionFinding('zzz');
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => [f]),
      };
    });
    const { scanPushVerdict } = await import('./push-leak-verdict.ts');
    const v = scanPushVerdict('/repo');
    expect(v.leak).toBe(true);
    expect(v.verdictRow).toContain('gitleaks detected secrets in 1 session transcript(s)');
    expect(v.recovery ?? '').toContain('nomad drop-session zzz');
    expect(v.findings).toEqual([f]);
  });

  it('returns a leak verdict with the scan-failed recovery string on a null report', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: vi.fn((): scanModule.Finding[] | null => null) };
    });
    const { scanPushVerdict } = await import('./push-leak-verdict.ts');
    const v = scanPushVerdict('/repo');
    expect(v.leak).toBe(true);
    expect(v.verdictRow).toContain('scan failed, no parseable report');
    expect(v.recovery ?? '').toContain('gitleaks scan failed: no parseable JSON report');
    expect(v.findings).toEqual([]);
  });

  it('maps an ENOENT scan throw to the install-hint recovery as a leak verdict', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
        }),
      };
    });
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof checksModule>();
      return {
        ...actual,
        gitleaksInstallHint: vi.fn(() => 'install gitleaks: brew install gitleaks'),
      };
    });
    const { scanPushVerdict } = await import('./push-leak-verdict.ts');
    const v = scanPushVerdict('/repo');
    expect(v.leak).toBe(true);
    expect(v.verdictRow).toContain('gitleaks not found');
    expect(v.recovery ?? '').toContain('install gitleaks');
    expect(v.findings).toEqual([]);
  });

  it('rethrows a non-ENOENT scan error (e.g. a TypeError) unchanged', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          throw new TypeError('synthetic non-ENOENT failure');
        }),
      };
    });
    const { scanPushVerdict } = await import('./push-leak-verdict.ts');
    expect(() => scanPushVerdict('/repo')).toThrow(TypeError);
    // Sanity: the spy exists so console.error is suppressed in the suite.
    expect(errSpy).toBeDefined();
  });
});
