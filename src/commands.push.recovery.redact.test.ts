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

import type * as utilsModule from './utils.ts';
import type * as utilsFsModule from './utils.fs.ts';
import type { PathMap } from './config.ts';
import type { Finding } from './push-gitleaks.scan.ts';

/**
 * Build a fixture: main transcript + optional subagents dir under a temp
 * CLAUDE_HOME. Returns paths + far-future clock so tests bypass the
 * live-session guard by default.
 */
function makeSubtreeFixture(testHome: string): {
  projectsDir: string;
  transcriptPath: string;
  sessionDir: string;
  farFuture: number;
  map: PathMap;
} {
  const claudeHome = join(testHome, '.claude');
  const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
  mkdirSync(projectsDir, { recursive: true });
  const transcriptPath = join(projectsDir, 'sid123.jsonl');
  writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');
  const sessionDir = join(projectsDir, 'sid123');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(testHome, 'path-map.json'),
    JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
  );
  const map: PathMap = {
    projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
  };
  return {
    projectsDir,
    transcriptPath,
    sessionDir,
    farFuture: Date.now() + 10 * 60 * 1000,
    map,
  };
}

// ---------------------------------------------------------------------------
// applyRedact: subagent-only secret is redacted and whole subtree is staged
// ---------------------------------------------------------------------------

describe('applyRedact: subagent-only secret is redacted and whole subtree is staged', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-sub-'));
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

  it('redacts agent-2.jsonl when the secret is ONLY in the subagent and stages the subtree', async () => {
    const { projectsDir, transcriptPath, sessionDir, farFuture, map } =
      makeSubtreeFixture(testHome);

    // Set up subagents dir with two agent files.
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agent1Path = join(subagentsDir, 'agent-1.jsonl');
    const agent2Path = join(subagentsDir, 'agent-2.jsonl');
    writeFileSync(agent1Path, '{"text":"clean"}\n');
    writeFileSync(agent2Path, '{"text":"real-secret-value"}\n');
    // Also write main transcript without the secret.
    writeFileSync(transcriptPath, '{"text":"main-clean"}\n');

    // Create staged tree dirs.
    const stagedProjectDir = join(testHome, 'shared', 'projects', 'myproject');
    mkdirSync(stagedProjectDir, { recursive: true });

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');

    // The trigger finding points at the subagent in the staged tree.
    const trigger: Finding = {
      RuleID: 'test-rule',
      File: `shared/projects/myproject/sid123/subagents/agent-2.jsonl`,
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };

    // Scan returns the real secret only for agent-2.jsonl; [] for everything else.
    const fakeScan = (p: string): Finding[] => {
      if (p === agent2Path) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 9,
            EndColumn: 25,
            Match: 'real-secret-value',
            Fingerprint: 'fp1',
          },
        ];
      }
      return [];
    };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);

    expect(result).toBe(true);
    // agent-2 must have been redacted.
    const agent2Written = readFileSync(agent2Path, 'utf8');
    expect(agent2Written).toContain('[REDACTED:test-rule]');
    expect(agent2Written).not.toContain('real-secret-value');
    // The main transcript must have been staged.
    expect(existsSync(join(stagedProjectDir, 'sid123.jsonl'))).toBe(true);
    // The agent-2 staged copy must exist.
    const stagedAgent2 = join(stagedProjectDir, 'sid123', 'subagents', 'agent-2.jsonl');
    expect(existsSync(stagedAgent2)).toBe(true);
    const stagedAgent2Content = readFileSync(stagedAgent2, 'utf8');
    expect(stagedAgent2Content).toContain('[REDACTED:test-rule]');
    expect(stagedAgent2Content).not.toContain('real-secret-value');
    void projectsDir; // keep fixture in scope to avoid unused-variable lint
  });
});

// ---------------------------------------------------------------------------
// applyRedact: live-session guard fires on newest subagent mtime
// ---------------------------------------------------------------------------

describe('applyRedact: live-session guard fires on newest subagent mtime', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redact-live-sub-'));
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

  it('returns false and writes nothing when agent file is within 5 minutes even if main is old', async () => {
    const { transcriptPath, sessionDir, map } = makeSubtreeFixture(testHome);

    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"clean"}\n');

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');

    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123/subagents/agent-1.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };

    const originalContent = readFileSync(transcriptPath, 'utf8');
    // Clock is 1 second after the agent file's mtime -> within 5-minute threshold.
    const liveClock = () => statSync(agentPath).mtimeMs + 1000;

    const result = applyRedact(trigger, [trigger], 'ts-x', map, liveClock);

    expect(result).toBe(false);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: .meta.json is copied but not redacted
// ---------------------------------------------------------------------------

describe('applyRedact: .meta.json is copied as-is and never carries [REDACTED:', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-meta-json-'));
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

  it('stages .meta.json unchanged alongside agent-*.jsonl', async () => {
    const { transcriptPath, sessionDir, farFuture, map } = makeSubtreeFixture(testHome);
    writeFileSync(transcriptPath, '{"text":"main-clean"}\n');

    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    const metaPath = join(subagentsDir, 'agent-1.meta.json');
    writeFileSync(agentPath, '{"text":"real-secret-value"}\n');
    writeFileSync(metaPath, '{"metadata":"original"}\n');

    const stagedProjectDir = join(testHome, 'shared', 'projects', 'myproject');
    mkdirSync(stagedProjectDir, { recursive: true });

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');

    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid123/subagents/agent-1.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };

    const fakeScan = (p: string): Finding[] => {
      if (p === agentPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 9,
            EndColumn: 25,
            Match: 'real-secret-value',
            Fingerprint: 'fp1',
          },
        ];
      }
      return [];
    };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);
    expect(result).toBe(true);

    // .meta.json is copied alongside the subagents dir.
    const stagedMeta = join(stagedProjectDir, 'sid123', 'subagents', 'agent-1.meta.json');
    expect(existsSync(stagedMeta)).toBe(true);
    // It must never carry [REDACTED: in its content.
    const metaContent = readFileSync(stagedMeta, 'utf8');
    expect(metaContent).not.toContain('[REDACTED:');
    expect(metaContent).toContain('original');
  });
});

// ---------------------------------------------------------------------------
// applyRedact: unsafe logical key is rejected via assertSafeLogical
// ---------------------------------------------------------------------------

describe('applyRedact: assertSafeLogical rejects an unsafe logical key', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-unsafe-logical-'));
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

  it('throws NomadFatal before any copy when logical key contains path traversal', async () => {
    // Build a real transcript so resolveLiveTranscript can find it.
    const claudeHome = join(testHome, '.claude');
    const encodedDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(encodedDir, { recursive: true });
    const transcriptPath = join(encodedDir, 'sid-unsafe.jsonl');
    writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');
    const { NomadFatal } = await import('./utils.ts');

    // A map with an unsafe logical key (contains path separator).
    const unsafeMap: PathMap = {
      projects: { '../../escape': { 'test-host': '/home/norm/git/myproject' } },
    };

    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid-unsafe.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp-unsafe',
    };

    const fakeScan = (p: string): Finding[] => {
      if (p === transcriptPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 9,
            EndColumn: 25,
            Match: 'real-secret-value',
            Fingerprint: 'fp-unsafe',
          },
        ];
      }
      return [];
    };

    const farFuture = Date.now() + 10 * 60 * 1000;
    expect(() =>
      applyRedact(trigger, [trigger], 'ts-x', unsafeMap, () => farFuture, fakeScan),
    ).toThrow(NomadFatal);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: clean agent (scan returns []) is skipped, not abort
// ---------------------------------------------------------------------------

describe('applyRedact: clean agent file does not abort the whole operation', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-clean-agent-'));
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

  it('returns true and stages the subtree when main has findings but agent is clean', async () => {
    const { transcriptPath, sessionDir, farFuture, map } = makeSubtreeFixture(testHome);
    // Main has the secret; agent is clean.
    writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');

    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const agentPath = join(subagentsDir, 'agent-1.jsonl');
    writeFileSync(agentPath, '{"text":"clean"}\n');

    const stagedProjectDir = join(testHome, 'shared', 'projects', 'myproject');
    mkdirSync(stagedProjectDir, { recursive: true });

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

    // Main scan returns a finding; agent scan returns [].
    const fakeScan = (p: string): Finding[] => {
      if (p === transcriptPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 9,
            EndColumn: 25,
            Match: 'real-secret-value',
            Fingerprint: 'fp1',
          },
        ];
      }
      return [];
    };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);
    expect(result).toBe(true);
    // Main is rewritten.
    const mainContent = readFileSync(transcriptPath, 'utf8');
    expect(mainContent).toContain('[REDACTED:test-rule]');
    // Agent file is unchanged (clean scan, no write).
    expect(readFileSync(agentPath, 'utf8')).toBe('{"text":"clean"}\n');
    // Staged subtree directory was created.
    expect(existsSync(join(stagedProjectDir, 'sid123.jsonl'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: no subagents dir at all - falls back to main-only behavior
// ---------------------------------------------------------------------------

describe('applyRedact: no subagents dir - works as before (main only)', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-no-subagents-'));
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

  it('returns true when only the main transcript has findings and no session dir exists', async () => {
    const claudeHome = join(testHome, '.claude');
    const projectsDir = join(claudeHome, 'projects', '-home-norm-git-myproject');
    mkdirSync(projectsDir, { recursive: true });
    const transcriptPath = join(projectsDir, 'sid-nodir.jsonl');
    writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');
    writeFileSync(
      join(testHome, 'path-map.json'),
      JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
    );
    const map: PathMap = {
      projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
    };
    const farFuture = Date.now() + 10 * 60 * 1000;

    const stagedProjectDir = join(testHome, 'shared', 'projects', 'myproject');
    mkdirSync(stagedProjectDir, { recursive: true });

    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { applyRedact } = await import('./commands.push.recovery.redact.ts');

    const trigger: Finding = {
      RuleID: 'test-rule',
      File: 'shared/projects/myproject/sid-nodir.jsonl',
      StartLine: 1,
      StartColumn: 9,
      EndColumn: 25,
      Match: 'REDACTED',
      Fingerprint: 'fp1',
    };

    const fakeScan = (p: string): Finding[] => {
      if (p === transcriptPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 9,
            EndColumn: 25,
            Match: 'real-secret-value',
            Fingerprint: 'fp1',
          },
        ];
      }
      return [];
    };

    const result = applyRedact(trigger, [trigger], 'ts-x', map, () => farFuture, fakeScan);
    expect(result).toBe(true);
    const mainContent = readFileSync(transcriptPath, 'utf8');
    expect(mainContent).toContain('[REDACTED:test-rule]');
    expect(existsSync(join(stagedProjectDir, 'sid-nodir.jsonl'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyRedact: scan null on main file -> returns false
// ---------------------------------------------------------------------------

describe('applyRedact: scan null on main file returns false (existing behavior preserved)', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scan-null-'));
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

  it('returns false when the main scan returns null (scan failed)', async () => {
    const { transcriptPath, sessionDir, farFuture, map } = makeSubtreeFixture(testHome);
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-1.jsonl'), '{"text":"clean"}\n');

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

    // Scan always returns null.
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
  });
});
