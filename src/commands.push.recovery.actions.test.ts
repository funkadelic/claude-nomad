import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as recoveryActionsModule from './commands.push.recovery.actions.ts';
import type * as redactModule from './commands.redact.core.ts';
import type * as memoryModule from './commands.push.recovery.memory.ts';
import type * as skillsModule from './commands.push.recovery.skills.ts';
import type * as utilsModule from './utils.ts';
import type { PathMap } from './config.ts';
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

  it('restores a pre-existing .gitleaksignore when the re-scan still leaks', async () => {
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

  it('leaves no .gitleaksignore behind when the re-scan still leaks and none existed', async () => {
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
// resolveLeakFindings: non-TTY + no resolution flag keeps the existing
// recovery body unchanged
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - unchanged recovery body (non-TTY, no allow/redact flags)', () => {
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

// ---------------------------------------------------------------------------
// collectActions - masked context line in prompt
// ---------------------------------------------------------------------------

/** Build a Finding with full field control for collectActions tests. */
function makeFullFinding(
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
    Match: overrides.Match ?? '',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    Description: 'GitHub PAT',
  };
}

describe('collectActions - masked context line in prompt', () => {
  const SECRET = 'ghp_FAKESECRETVALUE1234567890ABCDEF';

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a context line with masked span and surrounding text when readLine returns a line', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const line = `prefix_text ${SECRET} suffix_text`;
    const startCol = 'prefix_text '.length + 1;
    const endCol = 'prefix_text '.length + SECRET.length;
    const f = makeFullFinding({ StartColumn: startCol, EndColumn: endCol, Match: SECRET });

    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s'); // skip
    };
    const readLine = (_file: string, _line: number): string | null => line;

    await collectActions([f], prompt, readLine);

    expect(capturedPrompt).toContain('context:');
    expect(capturedPrompt).toContain('ghp_************');
    expect(capturedPrompt).toContain('prefix_text ');
    expect(capturedPrompt).not.toContain(SECRET);
  });

  it('offers [D]rop session in the menu header for a session finding', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({ File: 'shared/projects/my-proj/abc123.jsonl' });
    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s');
    };
    await collectActions([f], prompt, () => null);
    expect(capturedPrompt).toContain('[D]rop session');
    expect(capturedPrompt).toContain('(session:');
  });

  it('omits [D]rop session in the menu header for a non-session (skill) finding', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({ File: 'shared/skills/my-skill/SKILL.md' });
    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s');
    };
    await collectActions([f], prompt, () => null);
    // Drop is a no-op for a skill/memory finding, so the menu never offers it.
    expect(capturedPrompt).not.toContain('[D]rop');
    expect(capturedPrompt).toContain('[R]edact  [A]llow  [S]kip');
    expect(capturedPrompt).not.toContain('(session:');
  });

  it('emits a masked-Match context line when readLine returns null and Match is non-empty', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({ Match: SECRET });

    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s');
    };
    const readLine = (_file: string, _line: number): string | null => null;

    await collectActions([f], prompt, readLine);

    expect(capturedPrompt).toContain('context:');
    expect(capturedPrompt).toContain('ghp_************');
    expect(capturedPrompt).not.toContain(SECRET);
  });

  it('omits the context line when readLine returns null and Match is empty', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({ Match: '' });

    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s');
    };
    const readLine = (_file: string, _line: number): string | null => null;

    await collectActions([f], prompt, readLine);

    expect(capturedPrompt).not.toContain('context:');
    expect(capturedPrompt).toContain('Finding:');
    expect(capturedPrompt).toContain('[R]edact');
  });

  it('action map is unaffected by the new context line (default skip still applies)', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({ Match: SECRET });
    const prompt = (_p: string): Promise<string> => Promise.resolve(''); // empty -> skip
    const readLine = (_file: string, _line: number): string | null => null;

    const actions = await collectActions([f], prompt, readLine);

    expect(actions.size).toBe(1);
    const action = actions.values().next().value;
    expect(action).toBe('skip');
  });

  it('omits the [D]rop affordance for a memory finding with no resolvable session', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    const f = makeFullFinding({
      File: 'shared/memory/notes.md',
      Fingerprint: 'shared/memory/notes.md:github-pat:1',
    });

    let capturedPrompt = '';
    const prompt = (p: string): Promise<string> => {
      capturedPrompt = p;
      return Promise.resolve('s');
    };
    const readLine = (_file: string, _line: number): string | null => null;

    await collectActions([f], prompt, readLine);

    expect(capturedPrompt).toContain('[R]edact');
    expect(capturedPrompt).toContain('[A]llow');
    expect(capturedPrompt).toContain('[S]kip (default)');
    expect(capturedPrompt).not.toContain('[D]rop');
    expect(capturedPrompt).not.toContain('session:');
  });

  it('default real readLine reads from a fixture file under NOMAD_REPO', async () => {
    const originalNomadRepo = process.env.NOMAD_REPO;
    const testRepo = mkdtempSync(join(tmpdir(), 'nomad-ctx-reader-'));
    try {
      process.env.NOMAD_REPO = testRepo;
      vi.resetModules();
      const { collectActions } = await import('./commands.push.recovery.actions.ts');

      // Create a fixture file at shared/projects/my-proj/abc123.jsonl.
      const relPath = 'shared/projects/my-proj/abc123.jsonl';
      const dir = join(testRepo, 'shared/projects/my-proj');
      mkdirSync(dir, { recursive: true });
      const lineContent = `prefix_text ${SECRET} suffix_text`;
      writeFileSync(join(testRepo, relPath), lineContent + '\n', 'utf8');

      const startCol = 'prefix_text '.length + 1;
      const endCol = 'prefix_text '.length + SECRET.length;
      const f = makeFullFinding({
        File: relPath,
        StartLine: 1,
        StartColumn: startCol,
        EndColumn: endCol,
        Match: SECRET,
      });

      let capturedPrompt = '';
      const prompt = (p: string): Promise<string> => {
        capturedPrompt = p;
        return Promise.resolve('s');
      };

      // No readLine arg: uses the real default reader.
      await collectActions([f], prompt);

      expect(capturedPrompt).toContain('context:');
      expect(capturedPrompt).toContain('ghp_************');
      expect(capturedPrompt).not.toContain(SECRET);
    } finally {
      rmSync(testRepo, { recursive: true, force: true });
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
    }
  });

  it('default real readLine falls back to masked Match when file is missing', async () => {
    const originalNomadRepo = process.env.NOMAD_REPO;
    const testRepo = mkdtempSync(join(tmpdir(), 'nomad-ctx-missing-'));
    try {
      process.env.NOMAD_REPO = testRepo;
      vi.resetModules();
      const { collectActions } = await import('./commands.push.recovery.actions.ts');

      // No fixture file written: the reader throws ENOENT and returns null.
      // Match is non-empty so the fallback fires and shows a masked Match.
      const f = makeFullFinding({
        File: 'shared/projects/my-proj/missing.jsonl',
        StartLine: 1,
        Match: SECRET,
      });

      let capturedPrompt = '';
      const prompt = (p: string): Promise<string> => {
        capturedPrompt = p;
        return Promise.resolve('s');
      };

      await collectActions([f], prompt);

      // Falls back to masked Match.
      expect(capturedPrompt).toContain('context:');
      expect(capturedPrompt).toContain('ghp_************');
      expect(capturedPrompt).not.toContain(SECRET);
    } finally {
      rmSync(testRepo, { recursive: true, force: true });
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
    }
  });

  it('default real readLine returns null for an out-of-range line number (falls back to masked Match)', async () => {
    const originalNomadRepo = process.env.NOMAD_REPO;
    const testRepo = mkdtempSync(join(tmpdir(), 'nomad-ctx-oor-'));
    try {
      process.env.NOMAD_REPO = testRepo;
      vi.resetModules();
      const { collectActions } = await import('./commands.push.recovery.actions.ts');

      // Create a 1-line fixture; request line 999 (out of range -> null -> Match fallback).
      const relPath = 'shared/projects/my-proj/oor.jsonl';
      const dir = join(testRepo, 'shared/projects/my-proj');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(testRepo, relPath), 'only one line\n', 'utf8');

      const f = makeFullFinding({
        File: relPath,
        StartLine: 999,
        Match: SECRET,
      });

      let capturedPrompt = '';
      const prompt = (p: string): Promise<string> => {
        capturedPrompt = p;
        return Promise.resolve('s');
      };

      await collectActions([f], prompt);

      // Out-of-range line -> readLine returns null -> falls back to masked Match.
      expect(capturedPrompt).toContain('context:');
      expect(capturedPrompt).toContain('ghp_************');
      expect(capturedPrompt).not.toContain(SECRET);
    } finally {
      rmSync(testRepo, { recursive: true, force: true });
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
    }
  });

  it('default real readLine refuses a File that escapes the repo root via ..', async () => {
    const originalNomadRepo = process.env.NOMAD_REPO;
    const outer = mkdtempSync(join(tmpdir(), 'nomad-ctx-escape-'));
    try {
      const testRepo = join(outer, 'repo');
      mkdirSync(testRepo, { recursive: true });
      process.env.NOMAD_REPO = testRepo;
      vi.resetModules();
      const { collectActions } = await import('./commands.push.recovery.actions.ts');

      // A real secret-bearing file sits OUTSIDE the repo root. A traversal
      // File must not read it; the reader returns null and the prompt falls
      // back to the masked Match instead of leaking the outside file.
      writeFileSync(join(outer, 'outside.jsonl'), `leaked ${SECRET}\n`, 'utf8');

      const f = makeFullFinding({
        File: '../outside.jsonl',
        StartLine: 1,
        Match: SECRET,
      });

      let capturedPrompt = '';
      const prompt = (p: string): Promise<string> => {
        capturedPrompt = p;
        return Promise.resolve('s');
      };

      await collectActions([f], prompt);

      // Confinement guard -> null -> masked Match fallback, raw secret absent.
      expect(capturedPrompt).toContain('context:');
      expect(capturedPrompt).toContain('ghp_************');
      expect(capturedPrompt).not.toContain(SECRET);
    } finally {
      rmSync(outer, { recursive: true, force: true });
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
    }
  });

  it('default real readLine refuses an absolute File path', async () => {
    const originalNomadRepo = process.env.NOMAD_REPO;
    const testRepo = mkdtempSync(join(tmpdir(), 'nomad-ctx-abs-'));
    try {
      process.env.NOMAD_REPO = testRepo;
      vi.resetModules();
      const { collectActions } = await import('./commands.push.recovery.actions.ts');

      // An absolute File path must be refused, even when pointing inside the repo.
      const absFile = join(testRepo, 'abs.jsonl');
      writeFileSync(absFile, `leaked ${SECRET}\n`, 'utf8');

      const f = makeFullFinding({
        File: absFile,
        StartLine: 1,
        Match: SECRET,
      });

      let capturedPrompt = '';
      const prompt = (p: string): Promise<string> => {
        capturedPrompt = p;
        return Promise.resolve('s');
      };

      await collectActions([f], prompt);

      // Absolute path rejected -> null -> masked Match fallback.
      expect(capturedPrompt).toContain('context:');
      expect(capturedPrompt).toContain('ghp_************');
      expect(capturedPrompt).not.toContain(SECRET);
    } finally {
      rmSync(testRepo, { recursive: true, force: true });
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchActions - memory finding dispatch (Redact/Allow/Drop)
// ---------------------------------------------------------------------------

describe('dispatchActions - memory finding dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.memory.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./commands.redact.core.ts');
  });

  it('memory Redact invokes applyMemoryRedact exactly once for two findings in the same memory file', async () => {
    const applyMemoryRedactMock = vi.fn().mockReturnValue(true);
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/projects/myproj/memory/notes.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproj/memory/notes.md', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    // Second finding hits the redactedMemory dedupe (same logical/filename).
    expect(applyMemoryRedactMock).toHaveBeenCalledOnce();
  });

  it('memory Redact for two different memory files calls applyMemoryRedact once per file (no cross-file dedupe)', async () => {
    const applyMemoryRedactMock = vi.fn().mockReturnValue(true);
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/projects/myproj/memory/a.md' });
    const f2 = makeFinding({ File: 'shared/projects/myproj/memory/b.md' });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applyMemoryRedactMock).toHaveBeenCalledTimes(2);
  });

  it('does not mark a memory file redacted when applyMemoryRedact fails, retrying the next finding', async () => {
    const applyMemoryRedactMock = vi.fn().mockReturnValue(false);
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/projects/myproj/memory/notes.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproj/memory/notes.md', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    // applyMemoryRedact returned false both times, so the file was never
    // marked redacted and the second finding retried.
    expect(applyMemoryRedactMock).toHaveBeenCalledTimes(2);
  });

  it('memory Drop logs a refusal containing "cannot be dropped" and does not call ctx.drop', async () => {
    const logMock = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({ File: 'shared/projects/myproj/memory/notes.md' });
    const actions = new Map([[findingKey(f), 'drop' as const]]);
    const map: PathMap = { projects: {} };
    const dropSpy = vi.fn().mockReturnValue(true);

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
      drop: dropSpy,
    });

    expect(dropSpy).not.toHaveBeenCalled();
    const msgs = logMock.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes('cannot be dropped'))).toBe(true);
  });

  it('memory Allow still appends the fingerprint via applyAllow (unchanged, no sid dependency)', async () => {
    const appendMock = vi.fn();
    vi.doMock('./commands.redact.core.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof redactModule>();
      return { ...actual, appendGitleaksIgnore: appendMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({
      File: 'shared/projects/myproj/memory/notes.md',
      Fingerprint: 'fp-mem',
    });
    const actions = new Map([[findingKey(f), 'allow' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(appendMock).toHaveBeenCalledWith('fp-mem', '/repo');
  });

  it('a bare memory/ prefix with no filename logs a manual-scrub hint and does not redact', async () => {
    const applyMemoryRedactMock = vi.fn().mockReturnValue(true);
    const logMock = vi.fn();
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    // Under memory/ (so isMemoryFindingPath routes it to dispatchMemory) but with
    // no trailing filename, so memoryFileFromFinding returns null: the defensive
    // null-parse branch logs a manual-scrub hint instead of redacting.
    const f = makeFinding({ File: 'shared/projects/myproj/memory/' });
    const actions = new Map([[findingKey(f), 'redact' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applyMemoryRedactMock).not.toHaveBeenCalled();
    const msgs = logMock.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes('not auto-redactable'))).toBe(true);
  });

  it('a non-memory non-session finding is still a no-op for redact (dispatchMemory does not act)', async () => {
    const applyMemoryRedactMock = vi.fn();
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({ File: 'shared/other/not-a-session.txt' });
    const actions = new Map([[findingKey(f), 'redact' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applyMemoryRedactMock).not.toHaveBeenCalled();
  });

  it('a non-memory non-session finding is still a no-op for drop (no refusal logged)', async () => {
    const logMock = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({ File: 'shared/other/not-a-session.txt' });
    const actions = new Map([[findingKey(f), 'drop' as const]]);
    const map: PathMap = { projects: {} };
    const dropSpy = vi.fn();

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
      drop: dropSpy,
    });

    expect(dropSpy).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });

  it('a nested memory finding is now auto-redactable and routes to applyMemoryRedact', async () => {
    const applyMemoryRedactMock = vi.fn().mockReturnValue(true);
    vi.doMock('./commands.push.recovery.memory.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof memoryModule>();
      return { ...actual, applyMemoryRedact: applyMemoryRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({ File: 'shared/projects/myproj/memory/sub/x.md' });
    const actions = new Map([[findingKey(f), 'redact' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    // Nested and non-.md memory files now parse (multi-segment relPath), so a
    // nested finding is dispatched to applyMemoryRedact rather than logged as
    // not-auto-redactable.
    expect(applyMemoryRedactMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// dispatchActions - skill finding dispatch (Redact/Allow/Drop)
// ---------------------------------------------------------------------------

describe('dispatchActions - skill finding dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.skills.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./commands.redact.core.ts');
  });

  it('skill Redact invokes applySkillRedact exactly once for two findings in the same skill file', async () => {
    const applySkillRedactMock = vi.fn().mockReturnValue(true);
    vi.doMock('./commands.push.recovery.skills.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof skillsModule>();
      return { ...actual, applySkillRedact: applySkillRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    // Second finding hits the redactedSkills dedupe (same name/relPath).
    expect(applySkillRedactMock).toHaveBeenCalledOnce();
  });

  it('skill Redact for two different skill files calls applySkillRedact once per file (no cross-file dedupe)', async () => {
    const applySkillRedactMock = vi.fn().mockReturnValue(true);
    vi.doMock('./commands.push.recovery.skills.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof skillsModule>();
      return { ...actual, applySkillRedact: applySkillRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/skills/skill-a/SKILL.md' });
    const f2 = makeFinding({ File: 'shared/skills/skill-b/SKILL.md' });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applySkillRedactMock).toHaveBeenCalledTimes(2);
  });

  it('does not mark a skill file redacted when applySkillRedact fails, retrying the next finding', async () => {
    const applySkillRedactMock = vi.fn().mockReturnValue(false);
    vi.doMock('./commands.push.recovery.skills.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof skillsModule>();
      return { ...actual, applySkillRedact: applySkillRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f1 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);
    const map: PathMap = { projects: {} };

    dispatchActions([f1, f2], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    // applySkillRedact returned false both times, so the file was never
    // marked redacted and the second finding retried.
    expect(applySkillRedactMock).toHaveBeenCalledTimes(2);
  });

  it('skill Drop logs a refusal containing "cannot be dropped" and does not call ctx.drop', async () => {
    const logMock = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({ File: 'shared/skills/my-skill/SKILL.md' });
    const actions = new Map([[findingKey(f), 'drop' as const]]);
    const map: PathMap = { projects: {} };
    const dropSpy = vi.fn().mockReturnValue(true);

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
      drop: dropSpy,
    });

    expect(dropSpy).not.toHaveBeenCalled();
    const msgs = logMock.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes('cannot be dropped'))).toBe(true);
  });

  it('skill Allow still appends the fingerprint via applyAllow (unchanged, no sid dependency)', async () => {
    const appendMock = vi.fn();
    vi.doMock('./commands.redact.core.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof redactModule>();
      return { ...actual, appendGitleaksIgnore: appendMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const f = makeFinding({
      File: 'shared/skills/my-skill/SKILL.md',
      Fingerprint: 'fp-skill',
    });
    const actions = new Map([[findingKey(f), 'allow' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(appendMock).toHaveBeenCalledWith('fp-skill', '/repo');
  });

  it('a bare shared/skills/<name> path (no trailing file) is a genuine no-op via dispatchNonSession', async () => {
    const applySkillRedactMock = vi.fn();
    vi.doMock('./commands.push.recovery.skills.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof skillsModule>();
      return { ...actual, applySkillRedact: applySkillRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    // Bare `shared/skills/<name>` with no trailing file: isSkillFindingPath
    // requires a trailing separator, so this is a genuine non-skill no-op.
    const f = makeFinding({ File: 'shared/skills/my-skill' });
    const actions = new Map([[findingKey(f), 'redact' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applySkillRedactMock).not.toHaveBeenCalled();
  });

  it('a skill directory path with an empty relPath (dispatchSkill reached, parse fails) is a no-op', async () => {
    const applySkillRedactMock = vi.fn();
    vi.doMock('./commands.push.recovery.skills.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof skillsModule>();
      return { ...actual, applySkillRedact: applySkillRedactMock };
    });

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    // isSkillFindingPath matches (trailing separator present), but
    // skillFileFromFinding's relPath capture requires at least one char, so
    // dispatchSkill is reached and its own null-parse guard fires.
    const f = makeFinding({ File: 'shared/skills/my-skill/' });
    const actions = new Map([[findingKey(f), 'redact' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([f], actions, {
      ts: 'ts-x',
      map,
      nowMs: Date.now,
      repo: '/repo',
    });

    expect(applySkillRedactMock).not.toHaveBeenCalled();
  });
});
