import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('buildSkillsPreviewSection', () => {
  let testHome: string;
  let repoUnderHome: string;
  let sharedSkills: string;
  let localSkills: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-preview-skills-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    originalNomadRepo = process.env.NOMAD_REPO;
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedSkills = join(repoUnderHome, 'shared', 'skills');
    localSkills = join(testHome, '.claude', 'skills');
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns one row per skill shared/skills/ would overlay', async () => {
    mkdirSync(join(sharedSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(sharedSkills, 'another-skill'), { recursive: true });

    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    const section = buildSkillsPreviewSection();

    expect(section.header).toBe('Skills');
    expect(section.items.sort()).toEqual(['another-skill', 'team-skill']);
  });

  it('adds a local-only retained-count row only when non-zero', async () => {
    mkdirSync(join(sharedSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'my-unpushed-skill'), { recursive: true });

    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    const section = buildSkillsPreviewSection();

    expect(section.items).toContain('1 local-only present, not in repo (push to reconcile)');
  });

  it('omits the local-only row when the count is zero', async () => {
    mkdirSync(join(sharedSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'team-skill'), { recursive: true });

    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    const section = buildSkillsPreviewSection();

    expect(section.items.some((line) => line.includes('local-only'))).toBe(false);
  });

  it('returns an empty-items section when shared/skills/ does not exist', async () => {
    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    const section = buildSkillsPreviewSection();

    expect(section.header).toBe('Skills');
    expect(section.items).toEqual([]);
  });

  it('excludes gsd-* names from both the shared listing and the local-only count', async () => {
    mkdirSync(join(sharedSkills, 'gsd-thing'), { recursive: true });
    mkdirSync(join(sharedSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'gsd-local-only'), { recursive: true });
    mkdirSync(join(localSkills, 'team-skill'), { recursive: true });

    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    const section = buildSkillsPreviewSection();

    expect(section.items).not.toContain('gsd-thing');
    expect(section.items).toEqual(['team-skill']);
  });

  it('performs no filesystem mutation', async () => {
    mkdirSync(join(sharedSkills, 'team-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'my-unpushed-skill'), { recursive: true });

    const { buildSkillsPreviewSection } = await import('./preview.skills.ts');
    buildSkillsPreviewSection();

    // Both trees are exactly as seeded: no copy, no prune, no backup dir.
    expect(existsSync(join(sharedSkills, 'team-skill'))).toBe(true);
    expect(existsSync(join(localSkills, 'my-unpushed-skill'))).toBe(true);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });
});
