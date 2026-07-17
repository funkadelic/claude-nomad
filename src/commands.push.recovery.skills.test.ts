import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsFsModule from './utils.fs.ts';
import type * as utilsModule from './utils.ts';
import type { Finding } from './push-gitleaks.scan.ts';

/**
 * Unit tests for `src/commands.push.recovery.skills.ts`: the host-uniform
 * skill-file resolution and redaction seam. Fixtures mirror the REAL,
 * nested skill layout (`SKILL.md` plus a `references/*.md` subdir), unlike
 * memory's flat single-level layout, and never carry a `PathMap` (skills
 * need no host-mapping lookup).
 */

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    RuleID: overrides.RuleID ?? 'generic-api-key',
    File: overrides.File ?? 'shared/skills/foo/SKILL.md',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 1,
    EndColumn: overrides.EndColumn ?? 10,
    Match: overrides.Match ?? 'real-secret-value',
    Fingerprint: overrides.Fingerprint ?? 'fp1',
    Description: overrides.Description,
  };
}

/**
 * Build a fixture under a temp `HOME`: a skill `foo` with a flat `SKILL.md`
 * and a nested `references/notes.md`, plus a gsd-owned `gsd-foo` skill
 * (defense-in-depth refusal target).
 */
function makeSkillFixture(testHome: string): {
  skillDir: string;
  skillPath: string;
  nestedPath: string;
  gsdSkillPath: string;
} {
  const claudeHomeDir = join(testHome, '.claude');
  const skillDir = join(claudeHomeDir, 'skills', 'foo');
  const referencesDir = join(skillDir, 'references');
  mkdirSync(referencesDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, 'skill prose containing real-secret-value inline\n');
  const nestedPath = join(referencesDir, 'notes.md');
  writeFileSync(nestedPath, 'nested notes containing real-secret-value inline\n');

  const gsdSkillDir = join(claudeHomeDir, 'skills', 'gsd-foo');
  mkdirSync(gsdSkillDir, { recursive: true });
  const gsdSkillPath = join(gsdSkillDir, 'SKILL.md');
  writeFileSync(gsdSkillPath, 'gsd-owned skill, must never be auto-redacted\n');

  return { skillDir, skillPath, nestedPath, gsdSkillPath };
}

// ---------------------------------------------------------------------------
// skillFileFromFinding (pure)
// ---------------------------------------------------------------------------

describe('skillFileFromFinding (pure)', () => {
  it('returns {name, relPath} for a flat skill path', async () => {
    const { skillFileFromFinding } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/foo/SKILL.md' });
    expect(skillFileFromFinding(f)).toEqual({ name: 'foo', relPath: 'SKILL.md' });
  });

  it('returns {name, relPath} for a nested skill path, preserving internal separators', async () => {
    const { skillFileFromFinding } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/foo/references/notes.md' });
    expect(skillFileFromFinding(f)).toEqual({ name: 'foo', relPath: 'references/notes.md' });
  });

  it('returns null for a non-skill path', async () => {
    const { skillFileFromFinding } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/notes.md' });
    expect(skillFileFromFinding(f)).toBeNull();
  });

  it('returns null for a bare shared/skills/<name> path with no trailing file', async () => {
    const { skillFileFromFinding } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/foo' });
    expect(skillFileFromFinding(f)).toBeNull();
  });

  it('returns null for shared/skills/ alone', async () => {
    const { skillFileFromFinding } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/' });
    expect(skillFileFromFinding(f)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSkillFindingPath (pure)
// ---------------------------------------------------------------------------

describe('isSkillFindingPath (pure)', () => {
  it('is true for a nested finding under a named skill dir', async () => {
    const { isSkillFindingPath } = await import('./commands.push.recovery.skills.ts');
    expect(isSkillFindingPath(makeFinding({ File: 'shared/skills/foo/scripts/x.py' }))).toBe(true);
  });

  it('is false for a shared/projects/... path', async () => {
    const { isSkillFindingPath } = await import('./commands.push.recovery.skills.ts');
    expect(isSkillFindingPath(makeFinding({ File: 'shared/projects/foo/memory/a.md' }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSkillLocalPath
// ---------------------------------------------------------------------------

describe('resolveSkillLocalPath', () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-skills-resolve-'));
    process.env.HOME = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('returns the local path for a flat file when safe and existing', async () => {
    const { skillPath } = makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', 'SKILL.md')).toBe(skillPath);
  });

  it('returns the local path for a nested relPath, staying under the skill root', async () => {
    const { skillDir, nestedPath } = makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    const resolved = resolveSkillLocalPath('foo', 'references/notes.md');
    expect(resolved).toBe(nestedPath);
    expect(resolved).not.toBeNull();
    expect((resolved ?? '').startsWith(skillDir)).toBe(true);
  });

  it('returns null for a gsd-owned skill name', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('gsd-foo', 'SKILL.md')).toBeNull();
  });

  it('returns null when the name fails SAFE_SKILL_NAME (contains a separator)', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo/bar', 'SKILL.md')).toBeNull();
  });

  it('returns null when the name is exactly "."', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('.', 'SKILL.md')).toBeNull();
  });

  it('returns null when the name is exactly ".."', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('..', 'SKILL.md')).toBeNull();
  });

  it('returns null when relPath is empty', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', '')).toBeNull();
  });

  it('returns null when relPath has a leading /', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', '/SKILL.md')).toBeNull();
  });

  it('returns null when relPath contains a backslash', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', 'references\\notes.md')).toBeNull();
  });

  it('returns null when relPath has a ".." segment', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', '../gsd-foo/SKILL.md')).toBeNull();
  });

  it('returns null when relPath has a "." segment', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', './SKILL.md')).toBeNull();
  });

  it('returns null when relPath has an empty segment (double slash)', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', 'references//notes.md')).toBeNull();
  });

  it('returns null when the resolved local file does not exist on disk', async () => {
    makeSkillFixture(testHome);
    const { resolveSkillLocalPath } = await import('./commands.push.recovery.skills.ts');
    expect(resolveSkillLocalPath('foo', 'missing.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preflightSkillRedactable
// ---------------------------------------------------------------------------

describe('preflightSkillRedactable', () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-skills-preflight-'));
    process.env.HOME = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('returns null (would proceed) when the skill file resolves cleanly', async () => {
    makeSkillFixture(testHome);
    const { preflightSkillRedactable } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/foo/SKILL.md' });
    expect(preflightSkillRedactable(f)).toBeNull();
  });

  it('returns a refusal reason when the finding is not a skill file', async () => {
    makeSkillFixture(testHome);
    const { preflightSkillRedactable } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/notes.md' });
    expect(preflightSkillRedactable(f)).toMatch(/not a skill file/);
  });

  it('returns a refusal reason when the local file cannot be resolved', async () => {
    makeSkillFixture(testHome);
    const { preflightSkillRedactable } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/foo/missing.md' });
    expect(preflightSkillRedactable(f)).toMatch(/local file not found or unresolvable/);
  });

  it('returns a refusal reason when the skill is gsd-owned', async () => {
    makeSkillFixture(testHome);
    const { preflightSkillRedactable } = await import('./commands.push.recovery.skills.ts');
    const f = makeFinding({ File: 'shared/skills/gsd-foo/SKILL.md' });
    expect(preflightSkillRedactable(f)).toMatch(/local file not found or unresolvable/);
  });
});

// ---------------------------------------------------------------------------
// applySkillRedact
// ---------------------------------------------------------------------------

describe('applySkillRedact', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-skills-redact-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
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
  });

  it('scrubs a flat skill file, backs it up, copies the scrubbed file to the staged tree, returns true', async () => {
    const { skillPath } = makeSkillFixture(testHome);

    const backupSpy = vi.fn();
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });

    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/skills/foo/SKILL.md' });
    const fakeScan = (p: string): Finding[] =>
      p === skillPath
        ? [
            {
              RuleID: 'generic-api-key',
              File: p,
              StartLine: 1,
              StartColumn: 1,
              EndColumn: 10,
              Match: 'real-secret-value',
              Fingerprint: 'fp1',
            },
          ]
        : [];

    const result = applySkillRedact(trigger, 'ts-x', fakeScan);

    expect(result).toBe(true);
    expect(backupSpy).toHaveBeenCalledOnce();
    const localAfter = readFileSync(skillPath, 'utf8');
    expect(localAfter).toContain('[REDACTED:generic-api-key]');
    expect(localAfter).not.toContain('real-secret-value');
    const stagedPath = join(testHome, 'shared', 'skills', 'foo', 'SKILL.md');
    expect(existsSync(stagedPath)).toBe(true);
    const stagedContent = readFileSync(stagedPath, 'utf8');
    expect(stagedContent).toContain('[REDACTED:generic-api-key]');
    expect(stagedContent).not.toContain('real-secret-value');
  });

  it('preserves a nested relPath when copying the scrubbed file back to the staged tree', async () => {
    const { nestedPath } = makeSkillFixture(testHome);

    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/skills/foo/references/notes.md' });
    const fakeScan = (p: string): Finding[] =>
      p === nestedPath
        ? [
            {
              RuleID: 'generic-api-key',
              File: p,
              StartLine: 1,
              StartColumn: 1,
              EndColumn: 10,
              Match: 'real-secret-value',
              Fingerprint: 'fp1',
            },
          ]
        : [];

    const result = applySkillRedact(trigger, 'ts-x', fakeScan);

    expect(result).toBe(true);
    const stagedPath = join(testHome, 'shared', 'skills', 'foo', 'references', 'notes.md');
    expect(existsSync(stagedPath)).toBe(true);
    const stagedContent = readFileSync(stagedPath, 'utf8');
    expect(stagedContent).toContain('[REDACTED:generic-api-key]');
    expect(stagedContent).not.toContain('real-secret-value');
  });

  it('returns false and logs a refusal (no raw secret) when the finding is not a skill file', async () => {
    makeSkillFixture(testHome);
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });
    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/projects/foo/memory/notes.md' });

    const result = applySkillRedact(trigger, 'ts-x');

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const loggedMsg = logSpy.mock.calls[0]?.[0] as string;
    expect(loggedMsg).not.toContain('real-secret-value');
  });

  it('returns false when the local skill file cannot be resolved', async () => {
    makeSkillFixture(testHome);
    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/skills/foo/missing.md' });

    const result = applySkillRedact(trigger, 'ts-x');

    expect(result).toBe(false);
  });

  it('returns false when the re-scan fails (scan returns null)', async () => {
    makeSkillFixture(testHome);
    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/skills/foo/SKILL.md' });

    const result = applySkillRedact(trigger, 'ts-x', () => null);

    expect(result).toBe(false);
  });

  it('returns false when the re-scan finds nothing to redact (empty findings)', async () => {
    makeSkillFixture(testHome);
    const { applySkillRedact } = await import('./commands.push.recovery.skills.ts');
    const trigger = makeFinding({ File: 'shared/skills/foo/SKILL.md' });

    const result = applySkillRedact(trigger, 'ts-x', () => []);

    expect(result).toBe(false);
  });
});
