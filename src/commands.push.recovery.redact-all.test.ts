import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsFsModule from './utils.fs.ts';
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
// redactAllFindings - memory-aware batch redaction (--redact-all)
// ---------------------------------------------------------------------------

/**
 * Build a fixture combining a redactable session transcript AND a
 * project-level `memory/*.md` file under the same mapped project, plus a
 * matching `path-map.json`. Mirrors the empirically-observed layout: `memory/`
 * is a flat, project-level sibling of the session's `<sid>/` subtree.
 */
function makeMixedRedactAllFixture(testHome: string): {
  transcriptPath: string;
  memoryPath: string;
  farFuture: number;
  map: PathMap;
} {
  const claudeHomeDir = join(testHome, '.claude');
  const projectsDir = join(claudeHomeDir, 'projects', '-home-norm-git-myproject');
  mkdirSync(projectsDir, { recursive: true });
  const transcriptPath = join(projectsDir, 'sid123.jsonl');
  writeFileSync(transcriptPath, '{"text":"real-secret-value"}\n');
  const memoryDir = join(projectsDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'notes.md');
  writeFileSync(memoryPath, 'prose containing real-secret-value inline\n');
  writeFileSync(
    join(testHome, 'path-map.json'),
    JSON.stringify({ projects: { myproject: { 'test-host': '/home/norm/git/myproject' } } }),
  );
  const map: PathMap = {
    projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
  };
  return { transcriptPath, memoryPath, farFuture: Date.now() + 10 * 60 * 1000, map };
}

describe('redactAllFindings - memory-aware batch redaction', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redactall-memory-'));
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

  it('redacts a memory finding alongside a session finding in one batch', async () => {
    const { transcriptPath, memoryPath, farFuture, map } = makeMixedRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const scanSpy = vi.fn((p: string): Finding[] => {
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
      if (p === memoryPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 1,
            EndColumn: 10,
            Match: 'real-secret-value',
            Fingerprint: 'fp2',
          },
        ];
      }
      return [];
    });

    const sessionFinding = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    const memoryFinding = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    redactAllFindings([sessionFinding, memoryFinding], 'ts-x', map, () => farFuture, scanSpy);

    expect(readFileSync(transcriptPath, 'utf8')).toContain('[REDACTED:test-rule]');
    const memoryAfter = readFileSync(memoryPath, 'utf8');
    expect(memoryAfter).toContain('[REDACTED:test-rule]');
    expect(memoryAfter).not.toContain('real-secret-value');
  });

  it('redacts two findings in the same memory file once (dedup by logical/filename)', async () => {
    const { memoryPath, map } = makeMixedRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const scanSpy = vi.fn().mockReturnValue([
      {
        RuleID: 'test-rule',
        File: memoryPath,
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'real-secret-value',
        Fingerprint: 'fp2',
      },
    ] satisfies Finding[]);

    const f1 = makeFinding({ File: 'shared/projects/myproject/memory/notes.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/memory/notes.md', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => Date.now(), scanSpy);

    expect(scanSpy).toHaveBeenCalledOnce();
    const memoryAfter = readFileSync(memoryPath, 'utf8');
    expect(memoryAfter).toContain('[REDACTED:test-rule]');
  });

  it('aborts the whole batch (no local mutation) when a memory finding is unresolvable in preflight', async () => {
    const { transcriptPath, memoryPath, farFuture, map } = makeMixedRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const { NomadFatal } = await import('./utils.ts');
    const transcriptOriginal = readFileSync(transcriptPath, 'utf8');
    const memoryOriginal = readFileSync(memoryPath, 'utf8');
    const scanSpy = vi.fn().mockReturnValue([]);

    const sessionFinding = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    // memory/missing.md does not exist on disk -> preflightMemoryRedactable refuses.
    const unresolvableMemory = makeFinding({
      File: 'shared/projects/myproject/memory/missing.md',
    });

    expect(() =>
      redactAllFindings(
        [sessionFinding, unresolvableMemory],
        'ts-x',
        map,
        () => farFuture,
        scanSpy,
      ),
    ).toThrow(NomadFatal);
    // Preflight runs before any redaction, so scan never ran and neither the
    // mapped session nor the memory file was mutated (all-or-nothing).
    expect(scanSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(transcriptOriginal);
    expect(readFileSync(memoryPath, 'utf8')).toBe(memoryOriginal);
  });

  it('a lone unresolvable memory finding is not silently skipped: throws NomadFatal', async () => {
    makeMixedRedactAllFixture(testHome);
    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const { NomadFatal } = await import('./utils.ts');
    const emptyMap: PathMap = { projects: {} };
    const memoryFinding = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    expect(() => redactAllFindings([memoryFinding], 'ts-x', emptyMap, () => Date.now())).toThrow(
      NomadFatal,
    );
  });

  it('does not mark a memory file redacted when applyMemoryRedact fails (scan returns null), retrying the next finding', async () => {
    const { memoryPath, map } = makeMixedRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const original = readFileSync(memoryPath, 'utf8');
    const scanSpy = vi.fn().mockReturnValue(null);
    const f1 = makeFinding({ File: 'shared/projects/myproject/memory/notes.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/projects/myproject/memory/notes.md', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => Date.now(), scanSpy);

    // applyMemoryRedact returned false both times (scan null), so the memory
    // file was never marked redacted and the second finding retried.
    expect(scanSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(memoryPath, 'utf8')).toBe(original);
  });
});
// ---------------------------------------------------------------------------
// redactAllFindings - skill-aware batch redaction (--redact-all)
// ---------------------------------------------------------------------------

/**
 * Build a fixture combining a redactable session transcript, a project-level
 * `memory/*.md` file, AND a `shared/skills/<name>/...` skill file, plus a
 * matching `path-map.json`. Extends `makeMixedRedactAllFixture`'s layout with
 * a host-uniform skill file under `~/.claude/skills/<name>/`.
 */
function makeSkillRedactAllFixture(testHome: string): {
  transcriptPath: string;
  memoryPath: string;
  skillPath: string;
  farFuture: number;
  map: PathMap;
} {
  const base = makeMixedRedactAllFixture(testHome);
  const skillDir = join(testHome, '.claude', 'skills', 'my-skill');
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, 'skill prose containing real-secret-value inline\n');
  return { ...base, skillPath };
}

describe('redactAllFindings - skill-aware batch redaction', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-redactall-skill-'));
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

  it('redacts a mix of one session, one memory, and one skill finding in one batch', async () => {
    const { transcriptPath, memoryPath, skillPath, farFuture, map } =
      makeSkillRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const scanSpy = vi.fn((p: string): Finding[] => {
      if (p === transcriptPath || p === memoryPath || p === skillPath) {
        return [
          {
            RuleID: 'test-rule',
            File: p,
            StartLine: 1,
            StartColumn: 1,
            EndColumn: 10,
            Match: 'real-secret-value',
            Fingerprint: `fp-${p}`,
          },
        ];
      }
      return [];
    });

    const sessionFinding = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    const memoryFinding = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    const skillFinding = makeFinding({ File: 'shared/skills/my-skill/SKILL.md' });

    redactAllFindings(
      [sessionFinding, memoryFinding, skillFinding],
      'ts-x',
      map,
      () => farFuture,
      scanSpy,
    );

    expect(readFileSync(transcriptPath, 'utf8')).toContain('[REDACTED:test-rule]');
    expect(readFileSync(memoryPath, 'utf8')).toContain('[REDACTED:test-rule]');
    const skillAfter = readFileSync(skillPath, 'utf8');
    expect(skillAfter).toContain('[REDACTED:test-rule]');
    expect(skillAfter).not.toContain('real-secret-value');

    // The scrubbed skill file is also copied back to the staged tree.
    const stagedSkillPath = join(testHome, 'shared', 'skills', 'my-skill', 'SKILL.md');
    expect(readFileSync(stagedSkillPath, 'utf8')).toContain('[REDACTED:test-rule]');
  });

  it('redacts two findings in the same skill file once (dedup by name/relPath)', async () => {
    const { skillPath, map } = makeSkillRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const scanSpy = vi.fn().mockReturnValue([
      {
        RuleID: 'test-rule',
        File: skillPath,
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'real-secret-value',
        Fingerprint: 'fp-skill',
      },
    ] satisfies Finding[]);

    const f1 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => Date.now(), scanSpy);

    expect(scanSpy).toHaveBeenCalledOnce();
    const skillAfter = readFileSync(skillPath, 'utf8');
    expect(skillAfter).toContain('[REDACTED:test-rule]');
  });

  it('aborts the whole batch (no local mutation) when a skill finding is unresolvable in preflight', async () => {
    const { transcriptPath, skillPath, farFuture, map } = makeSkillRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const { NomadFatal } = await import('./utils.ts');
    const transcriptOriginal = readFileSync(transcriptPath, 'utf8');
    const skillOriginal = readFileSync(skillPath, 'utf8');
    const scanSpy = vi.fn().mockReturnValue([]);

    const sessionFinding = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    // shared/skills/missing-skill/SKILL.md has no local file on disk ->
    // preflightSkillRedactable refuses.
    const unresolvableSkill = makeFinding({
      File: 'shared/skills/missing-skill/SKILL.md',
    });

    expect(() =>
      redactAllFindings([sessionFinding, unresolvableSkill], 'ts-x', map, () => farFuture, scanSpy),
    ).toThrow(NomadFatal);
    // Preflight runs before any redaction, so scan never ran and neither the
    // mapped session nor the skill file was mutated (all-or-nothing).
    expect(scanSpy).not.toHaveBeenCalled();
    expect(readFileSync(transcriptPath, 'utf8')).toBe(transcriptOriginal);
    expect(readFileSync(skillPath, 'utf8')).toBe(skillOriginal);
  });

  it('a lone unresolvable skill finding is not silently skipped: throws NomadFatal', async () => {
    makeSkillRedactAllFixture(testHome);
    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const { NomadFatal } = await import('./utils.ts');
    const skillFinding = makeFinding({ File: 'shared/skills/missing-skill/SKILL.md' });

    expect(() =>
      redactAllFindings([skillFinding], 'ts-x', { projects: {} }, () => Date.now()),
    ).toThrow(NomadFatal);
  });

  it('does not mark a skill file redacted when applySkillRedact fails (scan returns null), retrying the next finding', async () => {
    const { skillPath, map } = makeSkillRedactAllFixture(testHome);
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: vi.fn(), freshBackupTs: () => 'ts-x' };
    });

    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const original = readFileSync(skillPath, 'utf8');
    const scanSpy = vi.fn().mockReturnValue(null);
    const f1 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 1 });
    const f2 = makeFinding({ File: 'shared/skills/my-skill/SKILL.md', StartLine: 2 });

    redactAllFindings([f1, f2], 'ts-x', map, () => Date.now(), scanSpy);

    // applySkillRedact returned false both times (scan null), so the skill
    // file was never marked redacted and the second finding retried.
    expect(scanSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(skillPath, 'utf8')).toBe(original);
  });

  it('a genuine non-session non-memory non-skill finding still refuses via the unchanged preflightRedactable path', async () => {
    const { redactAllFindings } = await import('./commands.push.recovery.redact-all.ts');
    const { NomadFatal } = await import('./utils.ts');
    const genuineFinding = makeFinding({ File: 'shared/other/not-a-session.txt' });

    expect(() =>
      redactAllFindings([genuineFinding], 'ts-x', { projects: {} }, () => Date.now()),
    ).toThrow(NomadFatal);
  });
});
