import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as recoveryActionsModule from './commands.push.recovery.actions.ts';
import type * as redactModule from './commands.redact.ts';
import type * as utilsModule from './utils.ts';
import type * as utilsFsModule from './utils.fs.ts';
import type { PathMap } from './config.ts';
import type { Finding } from './push-gitleaks.scan.ts';

// ---------------------------------------------------------------------------
// isTTY seam
// ---------------------------------------------------------------------------

describe('isTTY (pure seam)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns false when stdin.isTTY is undefined', async () => {
    const { isTTY } = await import('./commands.push.recovery.ts');
    expect(isTTY({ isTTY: undefined }, { isTTY: true })).toBe(false);
  });

  it('returns false when stdout.isTTY is undefined', async () => {
    const { isTTY } = await import('./commands.push.recovery.ts');
    expect(isTTY({ isTTY: true }, { isTTY: undefined })).toBe(false);
  });

  it('returns false when both are undefined', async () => {
    const { isTTY } = await import('./commands.push.recovery.ts');
    expect(isTTY({ isTTY: undefined }, { isTTY: undefined })).toBe(false);
  });

  it('returns true when both stdin and stdout report isTTY === true', async () => {
    const { isTTY } = await import('./commands.push.recovery.ts');
    expect(isTTY({ isTTY: true }, { isTTY: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasUnresolved seam
// ---------------------------------------------------------------------------

describe('hasUnresolved (pure seam)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns true when all actions are skip', async () => {
    const { hasUnresolved } = await import('./commands.push.recovery.ts');
    const m = new Map([
      ['a', 'skip' as const],
      ['b', 'skip' as const],
    ]);
    expect(hasUnresolved(m)).toBe(true);
  });

  it('returns true when at least one action is skip', async () => {
    const { hasUnresolved } = await import('./commands.push.recovery.ts');
    const m = new Map([
      ['a', 'allow' as const],
      ['b', 'skip' as const],
    ]);
    expect(hasUnresolved(m)).toBe(true);
  });

  it('returns false when all actions are resolved (no skip)', async () => {
    const { hasUnresolved } = await import('./commands.push.recovery.ts');
    const m = new Map([
      ['a', 'allow' as const],
      ['b', 'redact' as const],
      ['c', 'drop' as const],
    ]);
    expect(hasUnresolved(m)).toBe(false);
  });

  it('returns false for an empty map', async () => {
    const { hasUnresolved } = await import('./commands.push.recovery.ts');
    expect(hasUnresolved(new Map())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAction seam (from actions module)
// ---------------------------------------------------------------------------

describe('parseAction (pure seam)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('empty string -> skip (D-02 default)', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('')).toBe('skip');
  });

  it('blank whitespace -> skip', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('   ')).toBe('skip');
  });

  it('"r" -> redact', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('r')).toBe('redact');
  });

  it('"R" (uppercase) -> redact', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('R')).toBe('redact');
  });

  it('"a" -> allow', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('a')).toBe('allow');
  });

  it('"d" -> drop', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('d')).toBe('drop');
  });

  it('unknown input -> skip', async () => {
    const { parseAction } = await import('./commands.push.recovery.actions.ts');
    expect(parseAction('x')).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: non-TTY path
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - non-TTY path (D-01)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NomadFatal carrying verdict.recovery when not a TTY', async () => {
    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'gitleaks detected secrets; recover manually',
      findings: [],
    };
    const map: PathMap = { projects: {} };
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
// resolveLeakFindings: TTY interactive path
// ---------------------------------------------------------------------------

/** Build a minimal Finding fixture for test scenarios. */
function makeFinding(
  overrides: Partial<{
    RuleID: string;
    File: string;
    StartLine: number;
    StartColumn: number;
    EndColumn: number;
    Fingerprint: string;
  }> = {},
) {
  return {
    RuleID: overrides.RuleID ?? 'github-pat',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 5,
    EndColumn: overrides.EndColumn ?? 10,
    Match: 'REDACTED',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    Description: 'GitHub PAT',
  };
}

describe('resolveLeakFindings - TTY all-Skip -> NomadFatal (D-03)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NomadFatal when all findings are Skipped', async () => {
    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const finding = makeFinding();
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'session-aware fatal',
      findings: [finding],
    };
    const map: PathMap = { projects: {} };
    // Empty input -> skip (D-02 default), all-skip -> FATAL (D-03).
    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        isTTYCheck: () => true,
        makePrompt: () => () => Promise.resolve(''),
        scanVerdict: () => ({ leak: false, verdictRow: '✓', recovery: null, findings: [] }),
      }),
    ).rejects.toThrow(NomadFatal);
  });
});

describe('resolveLeakFindings - TTY Allow action -> re-scan clean -> returns', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.redact.ts');
    vi.doUnmock('./utils.ts');
  });

  it('calls appendGitleaksIgnore with the fingerprint and returns when re-scan is clean', async () => {
    const appendMock = vi.fn();
    vi.doMock('./commands.redact.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof redactModule>();
      return { ...actual, appendGitleaksIgnore: appendMock };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding({
      Fingerprint: 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    });
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'session-aware fatal',
      findings: [finding],
    };
    const map: PathMap = { projects: {} };

    // User types 'a' (Allow).
    await resolveLeakFindings(verdict, 'ts-001', map, {
      isTTYCheck: () => true,
      makePrompt: () => () => Promise.resolve('a'),
      scanVerdict: () => ({ leak: false, verdictRow: '✓', recovery: null, findings: [] }),
    });

    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock).toHaveBeenCalledWith('shared/projects/my-proj/abc123.jsonl:github-pat:1');
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: --redact-all path
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - --redact-all non-interactive batch redact', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
  });

  it('calls redactAllFindings and does not invoke the prompt, returns on clean re-scan', async () => {
    const redactAllMock = vi.fn();
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, redactAllFindings: redactAllMock };
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
    const map: PathMap = { projects: {} };
    const promptSpy = vi.fn(() => Promise.resolve(''));

    await resolveLeakFindings(verdict, 'ts-001', map, {
      redactAll: true,
      makePrompt: () => promptSpy,
      scanVerdict: () => ({ leak: false, verdictRow: '✓', recovery: null, findings: [] }),
    });

    expect(redactAllMock).toHaveBeenCalledOnce();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('--redact-all throws NomadFatal when re-scan still finds leaks', async () => {
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, redactAllFindings: vi.fn() };
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
    const map: PathMap = { projects: {} };

    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        redactAll: true,
        scanVerdict: () => ({
          leak: true,
          verdictRow: '✗ still leaking',
          recovery: 'still leaking',
          findings: [finding],
        }),
      }),
    ).rejects.toThrow(NomadFatal);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: scan DI
// ---------------------------------------------------------------------------

/**
 * Build a minimal transcript fixture in a temp REPO_HOME and return the
 * transcript path plus a far-future clock value.
 */
function makeApplyRedactFixture(testHome: string): {
  transcriptPath: string;
  farFuture: number;
  map: PathMap;
} {
  const claudeHome = join(testHome, '.claude');
  const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
  mkdirSync(projectsDir, { recursive: true });
  const transcriptPath = join(projectsDir, 'sid123.jsonl');
  writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');
  writeFileSync(
    join(testHome, 'path-map.json'),
    JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
  );
  const map: PathMap = {
    projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
  };
  return { transcriptPath, farFuture: Date.now() + 10 * 60 * 1000, map };
}

describe('applyRedact: injected scan returning real findings rewrites file', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-applyredact-'));
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

  it('rewrites local file and returns true when scan returns real findings', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.actions.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED', // masked push-verdict value
      Fingerprint: 'fp1',
    };
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 25,
        Match: 'real-secret-value', // real value from unmasked scan
        Fingerprint: 'fp1',
      },
    ];

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);

    expect(result).toBe(true);
    expect(backupSpy).toHaveBeenCalledOnce();
    const written = readFileSync(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:test-rule]');
    expect(written).not.toContain('real-secret-value');
  });

  it('returns false and does not mutate when scan returns null (scan failed)', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.actions.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };
    const originalContent = readFileSync(transcriptPath, 'utf8');

    const result = applyRedact(
      trigger,
      [trigger],
      'ts-x',
      map,
      () => farFuture,
      (_p: string) => null,
    );

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
  });

  it('returns false and does not mutate when scan returns [] (nothing found locally)', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy, freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.actions.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };
    const originalContent = readFileSync(transcriptPath, 'utf8');

    const result = applyRedact(
      trigger,
      [trigger],
      'ts-x',
      map,
      () => farFuture,
      (_p: string): Finding[] => [],
    );

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
  });
});
