import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';

/**
 * Unit tests for `src/commands.push.recovery.skills.ts`: the host-uniform
 * skill-file resolution seam. Fixtures mirror the REAL, nested skill layout
 * (`SKILL.md` plus a `references/*.md` subdir), unlike memory's flat
 * single-level layout, and never carry a `PathMap` (skills need no
 * host-mapping lookup).
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
