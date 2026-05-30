import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as recoveryActionsModule from './commands.push.recovery.actions.ts';
import type * as redactModule from './commands.redact.ts';
import type * as utilsModule from './utils.ts';
import type * as utilsFsModule from './utils.fs.ts';
import type { PathMap } from './config.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import type { LeakVerdict } from './push-leak-verdict.ts';

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
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    // User types 'a' (Allow).
    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      isTTYCheck: () => true,
      makePrompt: () => () => Promise.resolve('a'),
      scanVerdict: () => cleanVerdict,
    });

    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock).toHaveBeenCalledWith('shared/projects/my-proj/abc123.jsonl:github-pat:1');
    expect(result.leak).toBe(false);
    expect(result.verdictRow).toBe('✓ no leaks');
  });
});

describe('resolveLeakFindings - TTY Redact action -> re-scan clean -> returns final verdict', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
  });

  it('returns the final clean LeakVerdict after a successful Redact', async () => {
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return {
        ...actual,
        collectActions: vi.fn().mockResolvedValue(new Map([['fp1', 'redact']])),
        dispatchActions: vi.fn(),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding({ Fingerprint: 'fp1' });
    const verdict = {
      leak: true,
      verdictRow: '✗ gitleaks detected secrets in 1 session transcript(s)',
      recovery: 'session-aware fatal',
      findings: [finding],
    };
    const map: PathMap = { projects: {} };
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      isTTYCheck: () => true,
      makePrompt: () => () => Promise.resolve('r'),
      scanVerdict: () => cleanVerdict,
    });

    expect(result.leak).toBe(false);
    expect(result.verdictRow).toBe('✓ no leaks');
    expect(result.recovery).toBeNull();
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
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      redactAll: true,
      makePrompt: () => promptSpy,
      scanVerdict: () => cleanVerdict,
    });

    expect(redactAllMock).toHaveBeenCalledOnce();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(result.leak).toBe(false);
    expect(result.verdictRow).toBe('✓ no leaks');
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

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
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

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
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

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
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

// ---------------------------------------------------------------------------
// applyRedact: refusal messages
// ---------------------------------------------------------------------------

describe('applyRedact: live-session refusal emits guidance message', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-applyredact-live-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns false, no mutation, and emits live-session guidance when session is live', async () => {
    const { transcriptPath, map } = makeApplyRedactFixture(testHome);
    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };
    // nowMs() == file mtime => recently modified (live session)
    const liveClock = () => statSync(transcriptPath).mtimeMs + 1000;
    const originalContent = readFileSync(transcriptPath, 'utf8');

    const result = applyRedact(trigger, [trigger], 'ts-x', map, liveClock);

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('sid123');
    expect(msg).toContain('active');
    expect(msg).toMatch(/[Dd]rop session|[Ss]kip/);
    // Drop semantics must be explicit: excludes from push, local copy kept
    expect(msg).toMatch(/local copy kept|local.*kept/i);
    expect(msg).toMatch(/holds.*back.*from.*push|back from the push/i);
  });

  it('returns false and emits scan-failed message when scan returns null', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
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
      () => null,
    );

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/re-scan.*failed|scan.*failed/i);
    expect(msg).toMatch(/[Ss]kip|[Dd]rop/);
  });

  it('returns false and emits nothing-to-redact message when scan returns []', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
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
      (): Finding[] => [],
    );

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/nothing to redact/i);
    expect(msg).toMatch(/[Ss]kip|[Dd]rop/);
  });

  it('happy path: no log message emitted on success', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn() };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 25,
        Match: 'real-secret-value',
        Fingerprint: 'fp1',
      },
    ];

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);

    expect(result).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyRedact: unresolvable session-id (sid === null) emits guidance message
// ---------------------------------------------------------------------------

describe('applyRedact: unresolvable session-id emits guidance message', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.ts');
  });

  it('returns false and emits transcript-not-found message when session id cannot be extracted', async () => {
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    // File path that matches neither SESSION_PATH nor the subagent pattern.
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'unrecognized/path/file.txt',
      StartLine: 1,
      StartColumn: 1,
      EndColumn: 5,
      Match: 'secret',
      Fingerprint: 'fp-unresolvable',
    };
    const map: PathMap = { projects: {} };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => Date.now());

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/local transcript|session/i);
    expect(msg).toMatch(/[Ss]kip|[Dd]rop/);
  });

  it('returns false and emits transcript-not-found message when local transcript is absent', async () => {
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    // Valid session path so sid extracts, but NOMAD_REPO has no path-map.json
    // so resolveLiveTranscript returns null.
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/absent-sid.jsonl',
      StartLine: 1,
      StartColumn: 1,
      EndColumn: 5,
      Match: 'secret',
      Fingerprint: 'fp-absent',
    };
    const map: PathMap = { projects: {} };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => Date.now());

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('absent-sid');
    expect(msg).toMatch(/[Ss]kip|[Dd]rop/);
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: live session + Redact then Skip -> FATAL
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - live session + Redact then Skip aborts with NomadFatal', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-resolveleak-live-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./commands.push.recovery.actions.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('emits refusal guidance and throws NomadFatal when Redact (live) then Skip', async () => {
    // Build fixture: transcript exists and is live.
    const { transcriptPath, map } = makeApplyRedactFixture(testHome);
    const liveClock = () => statSync(transcriptPath).mtimeMs + 1000;

    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy, gitOrFatal: vi.fn() };
    });

    // scanVerdict: always returns the same live finding (re-scan still leaks).
    const finding = makeFinding({
      File: 'shared/projects/myproject/sid123.jsonl',
      Fingerprint: 'shared/projects/myproject/sid123.jsonl:github-pat:1',
    });
    const leakVerdict: LeakVerdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'session-aware fatal',
      findings: [finding],
    };

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');

    // Prompt sequence: first call returns 'r' (Redact), second returns '' (Skip).
    let promptCall = 0;
    const makePrompt = () => () => {
      promptCall += 1;
      return Promise.resolve(promptCall === 1 ? 'r' : '');
    };

    await expect(
      resolveLeakFindings(leakVerdict, 'ts-x', map, {
        isTTYCheck: () => true,
        nowMs: liveClock,
        scanVerdict: () => leakVerdict,
        makePrompt,
        scan: () => null,
      }),
    ).rejects.toThrow(NomadFatal);

    // The live-session refusal message was emitted during Redact.
    expect(logSpy).toHaveBeenCalled();
    const msgs: string[] = logSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => /active|live/i.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// printRecoveryLegend: exported helper
// ---------------------------------------------------------------------------

describe('printRecoveryLegend', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('prints all four action names to the injected sink', async () => {
    const { printRecoveryLegend } = await import('./commands.push.recovery.ts');
    const lines: string[] = [];
    printRecoveryLegend((line) => lines.push(line));
    const combined = lines.join('\n');
    expect(combined).toMatch(/Redact/);
    expect(combined).toMatch(/Allow/);
    expect(combined).toMatch(/Drop session/);
    expect(combined).toMatch(/Skip/);
  });

  it('explains Drop as excluding the session from the push with local copy kept', async () => {
    const { printRecoveryLegend } = await import('./commands.push.recovery.ts');
    const lines: string[] = [];
    printRecoveryLegend((line) => lines.push(line));
    const dropLine = lines.find((l) => l.includes('Drop session')) ?? '';
    expect(dropLine).toMatch(/exclude|excludes|hold|back from/i);
    const combined = lines.join('\n');
    expect(combined).toMatch(/local.*kept|kept.*local/i);
    expect(combined).toMatch(/not stopped|is not stopped/i);
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: legend printed once on TTY, not on non-TTY / --redact-all
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - legend emission', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.ts');
  });

  it('calls printLegend exactly once on the TTY interactive path', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });
    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding();
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'session-aware fatal',
      findings: [finding],
    };
    const map: PathMap = { projects: {} };
    const legendSpy = vi.fn();

    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        isTTYCheck: () => true,
        makePrompt: () => () => Promise.resolve(''),
        scanVerdict: () => ({ leak: false, verdictRow: '✓', recovery: null, findings: [] }),
        printLegend: legendSpy,
      }),
    ).rejects.toThrow(); // all-skip -> NomadFatal

    expect(legendSpy).toHaveBeenCalledOnce();
  });

  it('does NOT call printLegend on the non-TTY path', async () => {
    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const { NomadFatal } = await import('./utils.ts');
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'gitleaks detected secrets; recover manually',
      findings: [],
    };
    const map: PathMap = { projects: {} };
    const legendSpy = vi.fn();

    await expect(
      resolveLeakFindings(verdict, 'ts-001', map, {
        isTTYCheck: () => false,
        printLegend: legendSpy,
      }),
    ).rejects.toThrow(NomadFatal);

    expect(legendSpy).not.toHaveBeenCalled();
  });

  it('does NOT call printLegend on the --redact-all path', async () => {
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const redactAllMock = vi.fn();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return { ...actual, redactAllFindings: redactAllMock };
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
    const legendSpy = vi.fn();

    await resolveLeakFindings(verdict, 'ts-001', map, {
      redactAll: true,
      scanVerdict: () => ({ leak: false, verdictRow: '✓', recovery: null, findings: [] }),
      printLegend: legendSpy,
    });

    expect(legendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sessionIdFromFinding: id validation
// ---------------------------------------------------------------------------

describe('sessionIdFromFinding: id validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the session id for a normal UUID-style flat path', async () => {
    const { sessionIdFromFinding } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ File: 'shared/projects/my-proj/abc123-def_456.jsonl' });
    expect(sessionIdFromFinding(f)).toBe('abc123-def_456');
  });

  it('returns null when the flat-path id segment contains ".."', async () => {
    const { sessionIdFromFinding } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ File: 'shared/projects/my-proj/../x.jsonl' });
    expect(sessionIdFromFinding(f)).toBeNull();
  });

  it('returns null when the subagent-dir id segment contains ".."', async () => {
    const { sessionIdFromFinding } = await import('./commands.push.recovery.seams.ts');
    // subagent form: shared/projects/<logical>/<sid>/... -- inject ".." as sid
    const f = makeFinding({ File: 'shared/projects/my-proj/../subagent/sub.jsonl' });
    expect(sessionIdFromFinding(f)).toBeNull();
  });

  it('returns null for a path that matches neither known pattern', async () => {
    const { sessionIdFromFinding } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ File: 'unrecognized/path/file.txt' });
    expect(sessionIdFromFinding(f)).toBeNull();
  });

  it('returns the session id for a valid subagent-dir path', async () => {
    const { sessionIdFromFinding } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ File: 'shared/projects/my-proj/sid-abc/sub.jsonl' });
    expect(sessionIdFromFinding(f)).toBe('sid-abc');
  });
});

// ---------------------------------------------------------------------------
// findingKey: includes RuleID to prevent same-location collisions
// ---------------------------------------------------------------------------

describe('findingKey: includes RuleID', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('two findings with same File/StartLine/StartColumn but different RuleID produce different keys', async () => {
    const { findingKey } = await import('./commands.push.recovery.seams.ts');
    const base = {
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 5,
      StartColumn: 10,
      EndColumn: 20,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
      Description: 'test',
    };
    const f1 = { ...base, RuleID: 'github-pat' };
    const f2 = { ...base, RuleID: 'generic-api-key' };
    expect(findingKey(f1)).not.toBe(findingKey(f2));
  });

  it('two findings with same File/StartLine/StartColumn/RuleID produce the same key', async () => {
    const { findingKey } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ StartLine: 3, StartColumn: 7 });
    expect(findingKey(f)).toBe(findingKey({ ...f }));
  });

  it('key contains the RuleID segment', async () => {
    const { findingKey } = await import('./commands.push.recovery.seams.ts');
    const f = makeFinding({ RuleID: 'my-rule', StartLine: 1, StartColumn: 2 });
    expect(findingKey(f)).toContain('my-rule');
  });
});

// ---------------------------------------------------------------------------
// dispatchActions: drop wins at session level (drop then redact same session)
// ---------------------------------------------------------------------------

describe('dispatchActions - drop wins at session level', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-dropwins-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('scan is NOT invoked when drop already ran for the same session', async () => {
    // Use the injectable `scan` DI parameter as the observable: when drop wins,
    // applyRedact is never entered and scan is never called.
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');

    const scanSpy = vi.fn().mockReturnValue(null);
    const dropMock = vi.fn().mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Two findings for the same session (abc123): finding1 -> drop, finding2 -> redact.
    const finding1 = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 1,
      StartColumn: 1,
      RuleID: 'github-pat',
    });
    const finding2 = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 2,
      StartColumn: 5,
      RuleID: 'generic-api-key',
    });
    const actions = new Map([
      [findingKey(finding1), 'drop' as const],
      [findingKey(finding2), 'redact' as const],
    ]);
    const map: PathMap = { projects: { 'my-proj': { host: '/some/path' } } };

    dispatchActions([finding1, finding2], actions, 'ts-x', map, Date.now, scanSpy, dropMock);

    expect(dropMock).toHaveBeenCalledOnce();
    expect(dropMock).toHaveBeenCalledWith('abc123', map);
    // scan must not have been invoked: drop wins, applyRedact never proceeds.
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('allow action for a DIFFERENT session is not blocked by an earlier drop', async () => {
    // Use the Allow action for finding2 (def456, a different session from the
    // dropped abc123). applyAllow writes the fingerprint to .gitleaksignore
    // without needing a local transcript, so the outcome is observable via the
    // file system regardless of local env state.
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');

    const dropMock = vi.fn().mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // finding1 (sid abc123) -> drop; finding2 (different sid def456) -> allow.
    const finding1 = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 1,
      StartColumn: 1,
      RuleID: 'github-pat',
      Fingerprint: 'fp-abc123',
    });
    const finding2 = makeFinding({
      File: 'shared/projects/my-proj/def456.jsonl',
      StartLine: 1,
      StartColumn: 1,
      RuleID: 'github-pat',
      Fingerprint: 'fp-def456',
    });
    const actions = new Map([
      [findingKey(finding1), 'drop' as const],
      [findingKey(finding2), 'allow' as const],
    ]);
    const map: PathMap = { projects: { 'my-proj': { host: '/some/path' } } };

    dispatchActions([finding1, finding2], actions, 'ts-x', map, Date.now, undefined, dropMock);

    expect(dropMock).toHaveBeenCalledOnce();
    expect(dropMock).toHaveBeenCalledWith('abc123', map);
    // Allow for def456 must have written the fingerprint to .gitleaksignore in REPO_HOME.
    const { readFileSync: realRead, existsSync: realExists } = await import('node:fs');
    const ignoreFile = join(testHome, '.gitleaksignore');
    expect(realExists(ignoreFile)).toBe(true);
    expect(realRead(ignoreFile, 'utf8')).toContain('fp-def456');
  });

  it('allow action for the SAME session is skipped after a drop (drop wins)', async () => {
    // finding1 (abc123) -> drop; finding2 (SAME session abc123) -> allow. Drop
    // wins, so applyAllow must NOT write finding2's fingerprint even though its
    // action is allow.
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');

    const dropMock = vi.fn().mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const finding1 = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 1,
      StartColumn: 1,
      RuleID: 'github-pat',
      Fingerprint: 'fp-drop-abc',
    });
    const finding2 = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      StartLine: 2,
      StartColumn: 1,
      RuleID: 'generic-api-key',
      Fingerprint: 'fp-allow-abc',
    });
    const actions = new Map([
      [findingKey(finding1), 'drop' as const],
      [findingKey(finding2), 'allow' as const],
    ]);
    const map: PathMap = { projects: { 'my-proj': { host: '/some/path' } } };

    dispatchActions([finding1, finding2], actions, 'ts-x', map, Date.now, undefined, dropMock);

    expect(dropMock).toHaveBeenCalledWith('abc123', map);
    // Drop wins: the allow for the same dropped session must NOT write a fingerprint.
    const { existsSync: realExists, readFileSync: realRead } = await import('node:fs');
    const ignoreFile = join(testHome, '.gitleaksignore');
    if (realExists(ignoreFile)) {
      expect(realRead(ignoreFile, 'utf8')).not.toContain('fp-allow-abc');
    }
  });
});

// ---------------------------------------------------------------------------
// dropSessionFromStaged: filesystem removal
// ---------------------------------------------------------------------------

describe('dropSessionFromStaged', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-dropstagd-'));
    process.env.NOMAD_REPO = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
  });

  it('removes the jsonl file and returns true when it exists', async () => {
    const logical = 'my-proj';
    const sid = 'abc123';
    const dir = join(testHome, 'shared', 'projects', logical);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), 'content');

    const map: PathMap = { projects: { [logical]: { host: '/some/path' } } };
    const { dropSessionFromStaged } = await import('./commands.push.recovery.drop.ts');

    const result = dropSessionFromStaged(sid, map);

    expect(result).toBe(true);
    expect(existsSync(join(dir, `${sid}.jsonl`))).toBe(false);
  });

  it('removes the subagent directory recursively when it exists', async () => {
    const logical = 'my-proj';
    const sid = 'abc123';
    const projDir = join(testHome, 'shared', 'projects', logical);
    const subDir = join(projDir, sid);
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'sub.jsonl'), 'subagent');

    const map: PathMap = { projects: { [logical]: { host: '/some/path' } } };
    const { dropSessionFromStaged } = await import('./commands.push.recovery.drop.ts');

    const result = dropSessionFromStaged(sid, map);

    expect(result).toBe(true);
    expect(existsSync(subDir)).toBe(false);
  });

  it('returns false when map has no projects (empty map)', async () => {
    const map: PathMap = { projects: {} };
    const { dropSessionFromStaged } = await import('./commands.push.recovery.drop.ts');

    const result = dropSessionFromStaged('abc123', map);

    expect(result).toBe(false);
  });

  it('returns true and does not throw when neither jsonl nor subdir exists', async () => {
    const logical = 'my-proj';
    mkdirSync(join(testHome, 'shared', 'projects', logical), { recursive: true });
    const map: PathMap = { projects: { [logical]: { host: '/some/path' } } };
    const { dropSessionFromStaged } = await import('./commands.push.recovery.drop.ts');

    expect(() => dropSessionFromStaged('no-such-sid', map)).not.toThrow();
  });

  it('never touches paths outside REPO_HOME (CLAUDE_HOME safety)', async () => {
    const claudeProjects = join(testHome, '.claude', 'projects', 'my-proj');
    mkdirSync(claudeProjects, { recursive: true });
    writeFileSync(join(claudeProjects, 'abc123.jsonl'), 'local-transcript');

    const logical = 'my-proj';
    mkdirSync(join(testHome, 'shared', 'projects', logical), { recursive: true });
    const map: PathMap = { projects: { [logical]: { host: '/some/path' } } };
    const { dropSessionFromStaged } = await import('./commands.push.recovery.drop.ts');

    dropSessionFromStaged('abc123', map);

    expect(existsSync(join(claudeProjects, 'abc123.jsonl'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchActions: Drop action calls dropSessionFromStaged, not cmdDropSession
// ---------------------------------------------------------------------------

describe('dispatchActions - Drop action uses dropSessionFromStaged', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.drop.ts');
    vi.doUnmock('./utils.ts');
  });

  it('calls dropSessionFromStaged and logs the drop message', async () => {
    const dropMock = vi.fn().mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const finding = makeFinding({ File: 'shared/projects/my-proj/abc123.jsonl' });
    const actions = new Map([[findingKey(finding), 'drop' as const]]);
    const map: PathMap = { projects: { 'my-proj': { host: '/some/path' } } };

    dispatchActions([finding], actions, 'ts-x', map, Date.now, undefined, dropMock);

    expect(dropMock).toHaveBeenCalledOnce();
    expect(dropMock).toHaveBeenCalledWith('abc123', map);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('abc123');
    expect(msg).toMatch(/local transcript kept/i);
  });

  it('does not log when dropSessionFromStaged returns false (empty map)', async () => {
    const dropMock = vi.fn().mockReturnValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const finding = makeFinding({ File: 'shared/projects/my-proj/abc123.jsonl' });
    const actions = new Map([[findingKey(finding), 'drop' as const]]);
    const map: PathMap = { projects: {} };

    dispatchActions([finding], actions, 'ts-x', map, Date.now, undefined, dropMock);

    expect(dropMock).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: Drop -> clean re-scan -> push proceeds (no NomadFatal)
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - Drop action -> clean re-scan -> returns', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.push.recovery.actions.ts');
    vi.doUnmock('./utils.ts');
  });

  it('returns a clean verdict when user drops the only finding', async () => {
    vi.doMock('./commands.push.recovery.actions.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryActionsModule>();
      return {
        ...actual,
        collectActions: vi
          .fn()
          .mockResolvedValue(
            new Map([['shared/projects/my-proj/abc123.jsonl:github-pat:1', 'drop' as const]]),
          ),
        dispatchActions: vi.fn(),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitOrFatal: vi.fn() };
    });

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding({
      File: 'shared/projects/my-proj/abc123.jsonl',
      Fingerprint: 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    });
    const verdict = {
      leak: true,
      verdictRow: '✗ leak',
      recovery: 'session-aware fatal',
      findings: [finding],
    };
    const map: PathMap = { projects: { 'my-proj': { host: '/some/path' } } };
    const cleanVerdict = { leak: false, verdictRow: '✓ no leaks', recovery: null, findings: [] };

    const result = await resolveLeakFindings(verdict, 'ts-001', map, {
      isTTYCheck: () => true,
      makePrompt: () => () => Promise.resolve('d'),
      scanVerdict: () => cleanVerdict,
    });

    expect(result.leak).toBe(false);
    expect(result.verdictRow).toBe('✓ no leaks');
  });
});

// ---------------------------------------------------------------------------
// applyRedact: no-match in map -> returns false, emits message, no cpSync
// ---------------------------------------------------------------------------

describe('applyRedact: no map-match returns false and emits message', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-nomatch-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns false and emits refusal when local transcript resolves but no project prefix matches', async () => {
    // path-map.json lists otherproject so resolveLiveTranscript can find the
    // transcript. The map passed to applyRedact only has myproject, so the
    // copy-back loop has no matching entry and must return false.
    const claudeHome = join(testHome, '.claude');
    const encodedDir = join(claudeHome, 'projects', '-home-norm-git-otherproject');
    mkdirSync(encodedDir, { recursive: true });
    const transcriptPath = join(encodedDir, 'sid-nomatch.jsonl');
    writeFileSync(transcriptPath, '{"text":"secret"}\n');
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: { otherproject: { 'test-host': '/home/norm/git/otherproject' } },
      }),
    );
    // map only has myproject: the copy-back loop will find no prefix match.
    const map: PathMap = {
      projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
    };
    const farFuture = Date.now() + 10 * 60 * 1000;

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/otherproject/sid-nomatch.jsonl',
      StartLine: 1,
      StartColumn: 1,
      EndColumn: 5,
      Match: 'REDACTED',
      Fingerprint: 'fp-nomatch',
    };
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 15,
        Match: 'secret',
        Fingerprint: 'fp-nomatch',
      },
    ];

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const msg: string = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('sid-nomatch');
    expect(msg).toMatch(/[Dd]rop session|[Ss]kip/);
  });

  it('prefix-collision: writes staged copy under the correct logical (foobar not foo)', async () => {
    // Two logicals: foo -> /x/foo, foobar -> /x/foobar.
    // The live transcript lives under foobar's encoded dir.
    // The cpSync must target foobar, not foo.
    const claudeHome = join(testHome, '.claude');
    const encodedFoobar = join(claudeHome, 'projects', '-x-foobar');
    mkdirSync(encodedFoobar, { recursive: true });
    const transcriptPath = join(encodedFoobar, 'sid-bar.jsonl');
    writeFileSync(transcriptPath, '{"text":"real-secret"}\n');

    // Staged tree for both logicals.
    mkdirSync(join(testHome, 'shared', 'projects', 'foo'), { recursive: true });
    mkdirSync(join(testHome, 'shared', 'projects', 'foobar'), { recursive: true });

    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/x/foo' },
          foobar: { 'test-host': '/x/foobar' },
        },
      }),
    );
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/x/foo' },
        foobar: { 'test-host': '/x/foobar' },
      },
    };
    const farFuture = Date.now() + 10 * 60 * 1000;

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn() };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/foobar/sid-bar.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 20,
      Match: 'REDACTED',
      Fingerprint: 'fp-bar',
    };
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 20,
        Match: 'real-secret',
        Fingerprint: 'fp-bar',
      },
    ];

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);

    expect(result).toBe(true);
    // Staged copy must exist under foobar, not foo.
    expect(existsSync(join(testHome, 'shared', 'projects', 'foobar', 'sid-bar.jsonl'))).toBe(true);
    expect(existsSync(join(testHome, 'shared', 'projects', 'foo', 'sid-bar.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectActions: session-less finding omits the "(session: ...)" header tag
// ---------------------------------------------------------------------------

describe('collectActions - header for a finding with no resolvable session id', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('omits the "(session:" suffix when sessionIdFromFinding returns null', async () => {
    const { collectActions } = await import('./commands.push.recovery.actions.ts');
    // A File path that matches neither the flat nor subagent session pattern.
    const finding = makeFinding({ File: 'shared/other/not-a-session.txt' });
    const prompts: string[] = [];
    const prompt = (p: string): Promise<string> => {
      prompts.push(p);
      return Promise.resolve('s');
    };
    await collectActions([finding], prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('(session:');
  });
});

// ---------------------------------------------------------------------------
// redactAllFindings: dedup, sid-null skip, applyRedact true/false, default scan
// ---------------------------------------------------------------------------

describe('redactAllFindings - batch redaction branches', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redactall-'));
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

  it('is a no-op on an empty findings list (default scan arg, never invoked)', async () => {
    const { redactAllFindings } = await import('./commands.push.recovery.actions.ts');
    const map: PathMap = { projects: {} };
    // No scan argument: exercises the default-parameter path without touching gitleaks.
    expect(() => redactAllFindings([], 'ts-x', map, () => Date.now())).not.toThrow();
  });

  it('skips findings with no resolvable session id', async () => {
    const { redactAllFindings } = await import('./commands.push.recovery.actions.ts');
    const map: PathMap = { projects: {} };
    const scanSpy = vi.fn().mockReturnValue([]);
    const finding = makeFinding({ File: 'shared/other/not-a-session.txt' });
    redactAllFindings([finding], 'ts-x', map, () => Date.now(), scanSpy);
    // sid === null short-circuits before applyRedact, so scan is never called.
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('redacts the first finding per session and de-duplicates the rest', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });
    const { redactAllFindings } = await import('./commands.push.recovery.actions.ts');
    const scanSpy = vi.fn().mockReturnValue([
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 25,
        Match: 'real-secret-value',
        Fingerprint: 'fp1',
      },
    ] satisfies Finding[]);
    // Two findings for the same session (sid123): the second must be deduped.
    const f1 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => farFuture, scanSpy);

    // applyRedact ran once for the session (dedup), so scan was invoked once.
    expect(scanSpy).toHaveBeenCalledOnce();
    const written = readFileSync(transcriptPath, 'utf8');
    expect(written).toContain('[REDACTED:test-rule]');
  });

  it('does not mark a session redacted when applyRedact fails (scan returns null)', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });
    const { redactAllFindings } = await import('./commands.push.recovery.actions.ts');
    const original = readFileSync(transcriptPath, 'utf8');
    // scan returns null on every call: applyRedact returns false each time, so
    // the session is never added to redactedSids and the second call retries.
    const scanSpy = vi.fn().mockReturnValue(null);
    const f1 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => farFuture, scanSpy);

    expect(scanSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(transcriptPath, 'utf8')).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// dispatchActions: skip / unmapped-key / sid-null / redact success+dedup+fail
// ---------------------------------------------------------------------------

describe('dispatchActions - remaining dispatchOne branches', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-dispatchone-'));
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

  it('returns early for skip and for a finding with no entry in the actions map', async () => {
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const scanSpy = vi.fn();
    const skipped = makeFinding({ File: 'shared/projects/p/skip1.jsonl', StartLine: 1 });
    const unmapped = makeFinding({ File: 'shared/projects/p/none1.jsonl', StartLine: 2 });
    // skipped -> explicit 'skip'; unmapped has NO key in the map (defaults skip).
    const actions = new Map([[findingKey(skipped), 'skip' as const]]);
    const map: PathMap = { projects: { p: { 'test-host': '/x/p' } } };
    dispatchActions([skipped, unmapped], actions, 'ts-x', map, Date.now, scanSpy);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('returns early for a non-skip action whose finding has no resolvable session id', async () => {
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const scanSpy = vi.fn();
    const finding = makeFinding({ File: 'shared/other/not-a-session.txt' });
    const actions = new Map([[findingKey(finding), 'redact' as const]]);
    const map: PathMap = { projects: {} };
    dispatchActions([finding], actions, 'ts-x', map, Date.now, scanSpy);
    // sid === null short-circuits, so applyRedact (and scan) never run.
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('redacts a session once and de-duplicates a second redact for the same session', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const scanSpy = vi.fn().mockReturnValue([
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 25,
        Match: 'real-secret-value',
        Fingerprint: 'fp1',
      },
    ] satisfies Finding[]);
    const f1 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);

    dispatchActions([f1, f2], actions, 'ts-x', map, () => farFuture, scanSpy);

    // First redact succeeds and marks the session; the second is deduped.
    expect(scanSpy).toHaveBeenCalledOnce();
    expect(readFileSync(transcriptPath, 'utf8')).toContain('[REDACTED:test-rule]');
  });

  it('leaves the session unmarked when applyRedact fails (scan null), retrying the next finding', async () => {
    const { transcriptPath, farFuture, map } = makeApplyRedactFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });
    const { dispatchActions, findingKey } = await import('./commands.push.recovery.actions.ts');
    const original = readFileSync(transcriptPath, 'utf8');
    const scanSpy = vi.fn().mockReturnValue(null);
    const f1 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl', StartLine: 2 });
    const actions = new Map([
      [findingKey(f1), 'redact' as const],
      [findingKey(f2), 'redact' as const],
    ]);

    dispatchActions([f1, f2], actions, 'ts-x', map, () => farFuture, scanSpy);

    // applyRedact returned false both times, so the session was never marked
    // redacted and the second finding retried.
    expect(scanSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(transcriptPath, 'utf8')).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: project whose host map lacks the current host is skipped
// ---------------------------------------------------------------------------

describe('applyRedact - copy-back loop skips a project with no entry for this host', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-host-undef-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('./utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns false when the only mapped project has no entry for this host', async () => {
    // resolveLiveTranscript finds the transcript via path-map.json (otherproject
    // mapped to test-host). The map passed to applyRedact lists otherproject but
    // only for a DIFFERENT host, so the copy-back loop hits `abs === undefined`
    // and continues, leaving no match.
    const claudeHome = join(testHome, '.claude');
    const encodedDir = join(claudeHome, 'projects', '-home-norm-git-otherproject');
    mkdirSync(encodedDir, { recursive: true });
    const transcriptPath = join(encodedDir, 'sid-h.jsonl');
    writeFileSync(transcriptPath, '{"text":"secret"}\n');
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({
        projects: { otherproject: { 'test-host': '/home/norm/git/otherproject' } },
      }),
    );
    const map: PathMap = {
      projects: { otherproject: { 'other-host': '/home/norm/git/otherproject' } },
    };
    const farFuture = Date.now() + 10 * 60 * 1000;

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn() };
    });
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/otherproject/sid-h.jsonl',
      StartLine: 1,
      StartColumn: 1,
      EndColumn: 5,
      Match: 'REDACTED',
      Fingerprint: 'fp-h',
    };
    const fakeScan = (_p: string): Finding[] => [
      {
        RuleID: 'test-rule',
        File: transcriptPath,
        StartLine: 1,
        StartColumn: 9,
        EndColumn: 15,
        Match: 'secret',
        Fingerprint: 'fp-h',
      },
    ];

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);
    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// resolveLeakFindings: default readline prompt (makeRealPrompt) coverage
// ---------------------------------------------------------------------------

describe('resolveLeakFindings - default readline prompt', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:readline/promises');
  });

  it('uses the real readline-based prompt when makePrompt is not injected', async () => {
    // Mock node:readline/promises so makeRealPrompt's createInterface/question/
    // close path runs without a real TTY. A single "skip" answer aborts via
    // NomadFatal after exercising the default prompt closure.
    const questionMock = vi.fn().mockResolvedValue('s');
    const closeMock = vi.fn();
    vi.doMock('node:readline/promises', () => ({
      createInterface: vi.fn(() => ({ question: questionMock, close: closeMock })),
    }));

    const { resolveLeakFindings } = await import('./commands.push.recovery.ts');
    const finding = makeFinding({ File: 'shared/projects/p/abc123.jsonl', StartLine: 1 });
    const verdict: LeakVerdict = {
      leak: true,
      verdictRow: '✗ leak',
      findings: [finding],
      recovery: 'recovery body',
    };
    const map: PathMap = { projects: { p: { 'test-host': '/x/p' } } };

    await expect(
      resolveLeakFindings(verdict, 'ts-x', map, {
        isTTYCheck: () => true,
        scanVerdict: () => ({ leak: false, verdictRow: '✓', findings: [], recovery: null }),
        printLegend: () => undefined,
        // makePrompt intentionally omitted: exercises makeRealPrompt default.
      }),
    ).rejects.toThrow();

    expect(questionMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });
});
