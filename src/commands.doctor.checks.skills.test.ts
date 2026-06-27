import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { restoreEnv } from './commands.doctor.checks.test-helpers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a skills-test temp home: claude-nomad/ and .claude/ skeletons. */
function makeSkillsEnv(): {
  testHome: string;
  sharedSkills: string;
  localSkills: string;
} {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-skills-test-'));
  const sharedSkills = join(testHome, 'claude-nomad', 'shared', 'skills');
  const localSkills = join(testHome, '.claude', 'skills');
  mkdirSync(join(testHome, 'claude-nomad'), { recursive: true });
  mkdirSync(join(testHome, '.claude'), { recursive: true });
  return { testHome, sharedSkills, localSkills };
}

// ---------------------------------------------------------------------------
// Real git diff --no-index tests
// ---------------------------------------------------------------------------

describe('reportSkillsDivergence (real git)', () => {
  let testHome: string;
  let sharedSkills: string;
  let localSkills: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    ({ testHome, sharedSkills, localSkills } = makeSkillsEnv());
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('emits infoGlyph skip row when shared/skills is absent', async () => {
    mkdirSync(localSkills, { recursive: true });
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(infoGlyph);
    expect(out).toContain('no shared/skills/ to compare');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits infoGlyph skip row when local skills is absent (shared exists)', async () => {
    mkdirSync(sharedSkills, { recursive: true });
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(infoGlyph);
    expect(out).toContain('no local skills/ to compare');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits okGlyph row when both dirs exist and are identical', async () => {
    mkdirSync(join(sharedSkills, 'my-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'my-skill'), { recursive: true });
    writeFileSync(join(sharedSkills, 'my-skill', 'SKILL.md'), '# shared\n');
    writeFileSync(join(localSkills, 'my-skill', 'SKILL.md'), '# shared\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(okGlyph);
    expect(out).toContain('in sync with shared/skills/');
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).not.toBe(1);
  });

  it('emits warnGlyph with child item for a non-gsd skill modified locally', async () => {
    mkdirSync(join(sharedSkills, 'my-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'my-skill'), { recursive: true });
    writeFileSync(join(sharedSkills, 'my-skill', 'SKILL.md'), '# shared version\n');
    writeFileSync(join(localSkills, 'my-skill', 'SKILL.md'), '# local edit\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(warnGlyph);
    expect(out).toContain('1 file(s) diverge from shared/skills/');
    expect(out).toContain('my-skill/SKILL.md');
    expect(out).not.toContain('local only');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits warnGlyph with (repo only) child item for a non-gsd skill absent locally', async () => {
    mkdirSync(join(sharedSkills, 'my-skill'), { recursive: true });
    mkdirSync(localSkills, { recursive: true });
    writeFileSync(join(sharedSkills, 'my-skill', 'SKILL.md'), '# repo only\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(warnGlyph);
    expect(out).toContain('my-skill/SKILL.md');
    expect(out).toContain('(repo only)');
    expect(process.exitCode).not.toBe(1);
  });

  it('filters out a gsd-prefixed skill that is local-only and emits okGlyph', async () => {
    mkdirSync(join(localSkills, 'gsd-audit-fix'), { recursive: true });
    mkdirSync(sharedSkills, { recursive: true });
    writeFileSync(join(localSkills, 'gsd-audit-fix', 'SKILL.md'), '# gsd skill\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(okGlyph);
    expect(out).not.toContain(warnGlyph);
    expect(out).not.toContain('gsd-audit-fix');
    expect(process.exitCode).not.toBe(1);
  });

  it('warns only for non-gsd skills when both gsd and non-gsd are local-only', async () => {
    mkdirSync(join(localSkills, 'gsd-audit-fix'), { recursive: true });
    mkdirSync(join(localSkills, 'my-skill'), { recursive: true });
    mkdirSync(sharedSkills, { recursive: true });
    writeFileSync(join(localSkills, 'gsd-audit-fix', 'SKILL.md'), '# gsd\n');
    writeFileSync(join(localSkills, 'my-skill', 'SKILL.md'), '# user\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(warnGlyph);
    expect(out).toContain('1 file(s) diverge from shared/skills/');
    expect(out).toContain('my-skill/SKILL.md');
    expect(out).toContain('(local only)');
    expect(out).not.toContain('gsd-audit-fix');
    expect(process.exitCode).not.toBe(1);
  });

  it('does not set process.exitCode when a non-gsd skill diverges', async () => {
    mkdirSync(join(sharedSkills, 'my-skill'), { recursive: true });
    mkdirSync(join(localSkills, 'my-skill'), { recursive: true });
    writeFileSync(join(sharedSkills, 'my-skill', 'SKILL.md'), '# shared\n');
    writeFileSync(join(localSkills, 'my-skill', 'SKILL.md'), '# local different\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    const exitBefore = process.exitCode;
    reportSkillsDivergence(sec);
    expect(process.exitCode).toBe(exitBefore);
    expect(sec.items.join('\n')).toContain(warnGlyph);
  });
});

// ---------------------------------------------------------------------------
// Git not on PATH (mock)
// ---------------------------------------------------------------------------

describe('reportSkillsDivergence git not on PATH', () => {
  let testHome: string;
  let sharedSkills: string;
  let localSkills: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    ({ testHome, sharedSkills, localSkills } = makeSkillsEnv());
    process.env.HOME = testHome;
    delete process.env.NOMAD_REPO;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('treats git ENOENT as no divergence and emits okGlyph without throwing', async () => {
    mkdirSync(sharedSkills, { recursive: true });
    mkdirSync(localSkills, { recursive: true });
    writeFileSync(join(localSkills, 'my-skill', 'SKILL.md').replace('/my-skill', ''), 'x');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    vi.resetModules();
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportSkillsDivergence } = await import('./commands.doctor.checks.skills.ts');
    const sec = makeSection('Skills');
    reportSkillsDivergence(sec);
    const out = sec.items.join('\n');
    expect(out).toContain(okGlyph);
    expect(out).not.toContain(warnGlyph);
    expect(process.exitCode).not.toBe(1);
  });
});
