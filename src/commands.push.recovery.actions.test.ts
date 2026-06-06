import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as recoveryActionsModule from './commands.push.recovery.actions.ts';
import type * as redactModule from './commands.redact.core.ts';
import type * as utilsModule from './utils.ts';
import type { Finding } from './push-gitleaks.scan.ts';

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(
  overrides: Partial<{
    RuleID: string;
    File: string;
    StartLine: number;
    Fingerprint: string;
  }> = {},
): Finding {
  return {
    RuleID: overrides.RuleID ?? 'github-pat',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: 5,
    EndColumn: 10,
    Match: 'REDACTED',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    Description: 'GitHub PAT',
  };
}

// ---------------------------------------------------------------------------
// allowAllFindings
// ---------------------------------------------------------------------------

describe('allowAllFindings - appends each finding fingerprint', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-allowall-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('appends a fingerprint for every finding', async () => {
    const { allowAllFindings } = await import('./commands.push.recovery.actions.ts');
    const findings = [makeFinding({ Fingerprint: 'fp-1' }), makeFinding({ Fingerprint: 'fp-2' })];
    allowAllFindings(findings, testHome);
    const content = readFileSync(join(testHome, '.gitleaksignore'), 'utf8');
    expect(content).toContain('fp-1');
    expect(content).toContain('fp-2');
  });

  it('duplicate fingerprints collapse to one line (idempotent via appendGitleaksIgnore)', async () => {
    const { allowAllFindings } = await import('./commands.push.recovery.actions.ts');
    const findings = [
      makeFinding({ Fingerprint: 'fp-dup' }),
      makeFinding({ Fingerprint: 'fp-dup' }),
    ];
    allowAllFindings(findings, testHome);
    const content = readFileSync(join(testHome, '.gitleaksignore'), 'utf8');
    expect(content.split('\n').filter((l) => l === 'fp-dup')).toHaveLength(1);
  });

  it('is a no-op when findings array is empty', async () => {
    const { allowAllFindings } = await import('./commands.push.recovery.actions.ts');
    allowAllFindings([], testHome);
    expect(existsSync(join(testHome, '.gitleaksignore'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allowFindingsByRule
// ---------------------------------------------------------------------------

describe('allowFindingsByRule - appends only matching RuleID fingerprints', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-allowrule-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('appends only fingerprints whose RuleID matches', async () => {
    const { allowFindingsByRule } = await import('./commands.push.recovery.actions.ts');
    const findings = [
      makeFinding({ RuleID: 'github-pat', Fingerprint: 'fp-match-1' }),
      makeFinding({ RuleID: 'generic-api-key', Fingerprint: 'fp-no-match' }),
      makeFinding({ RuleID: 'github-pat', Fingerprint: 'fp-match-2' }),
    ];
    const count = allowFindingsByRule(findings, 'github-pat', testHome);
    const content = readFileSync(join(testHome, '.gitleaksignore'), 'utf8');
    expect(count).toBe(2);
    expect(content).toContain('fp-match-1');
    expect(content).toContain('fp-match-2');
    expect(content).not.toContain('fp-no-match');
  });

  it('duplicate matched fingerprints collapse to one line; count reflects findings matched', async () => {
    const { allowFindingsByRule } = await import('./commands.push.recovery.actions.ts');
    const findings = [
      makeFinding({ RuleID: 'github-pat', Fingerprint: 'fp-dup' }),
      makeFinding({ RuleID: 'github-pat', Fingerprint: 'fp-dup' }),
      makeFinding({ RuleID: 'other-rule', Fingerprint: 'fp-other' }),
    ];
    const count = allowFindingsByRule(findings, 'github-pat', testHome);
    const content = readFileSync(join(testHome, '.gitleaksignore'), 'utf8');
    // count is matched findings (2), even though idempotent append writes one line.
    expect(count).toBe(2);
    expect(content.split('\n').filter((l) => l === 'fp-dup')).toHaveLength(1);
    expect(content).not.toContain('fp-other');
  });

  it('is a no-op-with-count-zero when no findings match the rule', async () => {
    const { allowFindingsByRule } = await import('./commands.push.recovery.actions.ts');
    const findings = [makeFinding({ RuleID: 'other-rule', Fingerprint: 'fp-other' })];
    const count = allowFindingsByRule(findings, 'github-pat', testHome);
    expect(count).toBe(0);
    expect(existsSync(join(testHome, '.gitleaksignore'))).toBe(false);
  });

  it('does not throw when no findings match', async () => {
    const { allowFindingsByRule } = await import('./commands.push.recovery.actions.ts');
    expect(() => allowFindingsByRule([], 'some-rule', testHome)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: --allow-all path
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - allowAll non-interactive path', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-resolveallow-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('calls allowAllFindings, re-stages, and returns clean verdict', async () => {
    const allowAllMock = vi.fn();
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, allowAllFindings: allowAllMock };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding();
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: null,
      findings: [finding],
    };
    const map = { projects: {} };
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      allowAll: true,
      scanVerdict: () => cleanVerdict,
    });

    expect(allowAllMock).toHaveBeenCalledOnce();
    expect(result.leak).toBe(false);
  });

  it('throws NomadFatal when re-scan still reports a leak after allowAll', async () => {
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, allowAllFindings: vi.fn() };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const finding = makeFinding();
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: null,
      findings: [finding],
    };
    const map = { projects: {} };

    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        allowAll: true,
        scanVerdict: () => ({
          leak: true,
          verdictRow: '✗ still leaking',
          recovery: 'still leaking',
          findings: [finding],
        }),
      }),
    ).rejects.toThrow(NomadFatal);
  });

  it('restores a pre-existing .gitleaksignore when the re-scan still leaks (WR-03)', async () => {
    // Real allowAllFindings (no mock) so the fingerprint is actually written,
    // then the surviving-leak abort must roll the file back to its prior state.
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const ignPath = join(testHome, '.gitleaksignore');
    const original = 'pre-existing:rule:1\n';
    writeFileSync(ignPath, original, 'utf8');

    const finding = makeFinding();
    const verdict = { leak: true, verdictRow: '✗ leak', recovery: null, findings: [finding] };

    await expect(
      resolveLeakFindings(
        verdict,
        'ts-001',
        { projects: {} },
        {
          allowAll: true,
          scanVerdict: () => ({
            leak: true,
            verdictRow: '✗ still leaking',
            recovery: 'still leaking',
            findings: [finding],
          }),
        },
      ),
    ).rejects.toThrow(NomadFatal);

    // The eagerly-written allow entry is rolled back; only the prior content remains.
    expect(readFileSync(ignPath, 'utf8')).toBe(original);
  });

  it('leaves no .gitleaksignore behind when the re-scan still leaks and none existed (WR-03)', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const ignPath = join(testHome, '.gitleaksignore');
    expect(existsSync(ignPath)).toBe(false);

    const finding = makeFinding();
    const verdict = { leak: true, verdictRow: '✗ leak', recovery: null, findings: [finding] };

    await expect(
      resolveLeakFindings(
        verdict,
        'ts-001',
        { projects: {} },
        {
          allowAll: true,
          scanVerdict: () => ({
            leak: true,
            verdictRow: '✗ still leaking',
            recovery: 'still leaking',
            findings: [finding],
          }),
        },
      ),
    ).rejects.toThrow(NomadFatal);

    // No allowlist file is left on disk for a push that never happened.
    expect(existsSync(ignPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: --allow-rule path
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - allowRule non-interactive path', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-resolveallowrule-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('calls allowFindingsByRule with correct rule, re-stages, returns clean verdict', async () => {
    const allowRuleMock = vi.fn().mockReturnValue(1);
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, allowFindingsByRule: allowRuleMock };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding({ RuleID: 'github-pat' });
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: null,
      findings: [finding],
    };
    const map = { projects: {} };
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      allowRule: 'github-pat',
      scanVerdict: () => cleanVerdict,
    });

    expect(allowRuleMock).toHaveBeenCalledWith([finding], 'github-pat', testHome);
    expect(result.leak).toBe(false);
  });

  it('throws NomadFatal when re-scan still reports a leak after allowRule (non-matching finding survives)', async () => {
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, allowFindingsByRule: vi.fn().mockReturnValue(1) };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const finding = makeFinding();
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: null,
      findings: [finding],
    };
    const map = { projects: {} };

    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        allowRule: 'github-pat',
        scanVerdict: () => ({
          leak: true,
          verdictRow: '✗ still leaking',
          recovery: 'still leaking',
          findings: [finding],
        }),
      }),
    ).rejects.toThrow(NomadFatal);
  });

  it('allowRule with zero matches logs a notice and still re-scans', async () => {
    const allowRuleMock = vi.fn().mockReturnValue(0);
    const logMock = vi.fn();
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, allowFindingsByRule: allowRuleMock };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn(), log: logMock };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const finding = makeFinding({ RuleID: 'other-rule' });
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: null,
      findings: [finding],
    };
    const map = { projects: {} };

    // Re-scan still shows a leak (the non-matching finding survived)
    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        allowRule: 'github-pat',
        scanVerdict: () => ({
          leak: true,
          verdictRow: '✗ still',
          recovery: 'still leaking',
          findings: [finding],
        }),
      }),
    ).rejects.toThrow(NomadFatal);

    // A notice must have been logged about the zero-match case
    const msgs: string[] = logMock.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes('github-pat'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: D-01 preserved - non-TTY + no resolution flag
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - D-01 preserved (non-TTY, no allow/redact flags)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NomadFatal carrying recovery body when non-TTY and no resolution flags', async () => {
    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'gitleaks detected secrets; recover manually',
      findings: [],
    };
    const map = { projects: {} };
    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        isTTYCheck: () => false,
      }),
    ).rejects.toThrow(NomadFatal);
    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        isTTYCheck: () => false,
      }),
    ).rejects.toThrow('gitleaks detected secrets; recover manually');
  });
});

// ---------------------------------------------------------------------------
// allowAllFindings: appendGitleaksIgnore called per finding
// ---------------------------------------------------------------------------

describe('allowAllFindings - calls appendGitleaksIgnore for each finding', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.redact.core.ts');
  });

  it('calls appendGitleaksIgnore with each finding Fingerprint', async () => {
    const appendMock = vi.fn();
    vi.doMock('./commands.redact.core.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof redactModule>();
      return { ...actual, appendGitleaksIgnore: appendMock };
    });

    const { allowAllFindings } = await import('./commands.push.recovery.actions.ts');
    const findings = [makeFinding({ Fingerprint: 'fp-a' }), makeFinding({ Fingerprint: 'fp-b' })];
    allowAllFindings(findings, '/repo');
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(appendMock).toHaveBeenCalledWith('fp-a', '/repo');
    expect(appendMock).toHaveBeenCalledWith('fp-b', '/repo');
  });
});

// ---------------------------------------------------------------------------
// Scaffold: confirm both new exports are available from the module
// ---------------------------------------------------------------------------

describe('module exports: allowAllFindings + allowFindingsByRule', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports allowAllFindings as a function', async () => {
    const mod = await import('./commands.push.recovery.actions.ts');
    expect(typeof mod.allowAllFindings).toBe('function');
  });

  it('exports allowFindingsByRule as a function', async () => {
    const mod = await import('./commands.push.recovery.actions.ts');
    expect(typeof mod.allowFindingsByRule).toBe('function');
  });
});
