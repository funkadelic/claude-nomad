import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copySkillsPull, copySkillsPush, isGsdOwned, isSkillExcluded } from './skills-sync.ts';

describe('isGsdOwned', () => {
  it('returns true for a gsd-prefixed name', () => {
    expect(isGsdOwned('gsd-graphify')).toBe(true);
  });

  it('returns true for another gsd-prefixed name', () => {
    expect(isGsdOwned('gsd-prompt-guard')).toBe(true);
  });

  it('returns false for graphify (user skill)', () => {
    expect(isGsdOwned('graphify')).toBe(false);
  });

  it('returns false for patch-coverage-check (user skill)', () => {
    expect(isGsdOwned('patch-coverage-check')).toBe(false);
  });

  it('returns false for pr-feedback-sweep (user skill)', () => {
    expect(isGsdOwned('pr-feedback-sweep')).toBe(false);
  });

  it('returns false for bare "gsd" without trailing hyphen', () => {
    expect(isGsdOwned('gsd')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGsdOwned('')).toBe(false);
  });
});

describe('isSkillExcluded', () => {
  it('excludes a gsd-owned name', () => {
    expect(isSkillExcluded('gsd-foo')).toBe(true);
  });

  it('excludes an ALWAYS_NEVER_SYNC name (settings.local.json)', () => {
    expect(isSkillExcluded('settings.local.json')).toBe(true);
  });

  it('excludes a credentials file name', () => {
    expect(isSkillExcluded('.credentials.json')).toBe(true);
  });

  it('does not exclude a user skill name', () => {
    expect(isSkillExcluded('graphify')).toBe(false);
  });
});

describe('copySkillsPush', () => {
  let tmp: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-skills-push-'));
    src = join(tmp, 'src-skills');
    dst = join(tmp, 'dst-skills');
    mkdirSync(src, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies user skills to dst and excludes gsd-owned entries', () => {
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');
    mkdirSync(join(src, 'pr-feedback-sweep'), { recursive: true });
    writeFileSync(join(src, 'pr-feedback-sweep', 'SKILL.md'), '# pr-feedback-sweep\n');
    mkdirSync(join(src, 'gsd-foo'), { recursive: true });
    writeFileSync(join(src, 'gsd-foo', 'SKILL.md'), '# gsd-foo\n');

    copySkillsPush(src, dst);

    const dstNames = readdirSync(dst).sort();
    expect(dstNames).toEqual(['graphify', 'pr-feedback-sweep']);
    expect(existsSync(join(dst, 'gsd-foo'))).toBe(false);
  });

  it('removes a pre-existing stale gsd-* entry in dst (push is a mirror)', () => {
    // A stale gsd-* entry left from the symlink era must be removed on push.
    mkdirSync(dst, { recursive: true });
    mkdirSync(join(dst, 'gsd-stale'), { recursive: true });
    writeFileSync(join(dst, 'gsd-stale', 'old.md'), 'stale\n');

    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');
    // gsd-stale is NOT in src (simulates stale repo content from symlink era).

    copySkillsPush(src, dst);

    // gsd-stale must not survive in dst after the mirror copy.
    expect(existsSync(join(dst, 'gsd-stale'))).toBe(false);
    expect(existsSync(join(dst, 'graphify'))).toBe(true);
  });

  it('produces an empty dst when src contains only gsd-owned entries', () => {
    mkdirSync(join(src, 'gsd-a'), { recursive: true });
    mkdirSync(join(src, 'gsd-b'), { recursive: true });

    copySkillsPush(src, dst);

    expect(existsSync(dst)).toBe(true);
    expect(readdirSync(dst)).toEqual([]);
  });

  it('excludes a NEVER_SYNC file nested inside a user skill (WR-02)', () => {
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');
    // A stray host-config file nested under a user skill must not ride into dst.
    writeFileSync(join(src, 'graphify', 'settings.local.json'), '{}\n');

    copySkillsPush(src, dst);

    expect(existsSync(join(dst, 'graphify', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'graphify', 'settings.local.json'))).toBe(false);
  });
});

describe('copySkillsPull', () => {
  let tmp: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-skills-pull-'));
    src = join(tmp, 'src-skills');
    dst = join(tmp, 'dst-skills');
    mkdirSync(src, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('overlays user skills into dst while preserving a local gsd-* skill', () => {
    // dst already has a locally-installed gsd skill.
    mkdirSync(join(dst, 'gsd-local'), { recursive: true });
    writeFileSync(join(dst, 'gsd-local', 'SKILL.md'), '# gsd-local\n');

    // src (repo) provides one user skill.
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');

    copySkillsPull(src, dst);

    // gsd-local must survive (not rmSync'd); graphify must be overlaid.
    expect(existsSync(join(dst, 'gsd-local'))).toBe(true);
    expect(existsSync(join(dst, 'graphify'))).toBe(true);
  });

  it('preserves a local gsd-* entry that is ABSENT from src (the load-bearing D-2 case)', () => {
    // This is the critical case: a gsd-* skill present in dst but NOT in src.
    // A src-scanned blockSet would not contain it and would delete it.
    // The predicate-driven variant must preserve it regardless of src content.
    mkdirSync(join(dst, 'gsd-only-in-dst'), { recursive: true });
    writeFileSync(join(dst, 'gsd-only-in-dst', 'SKILL.md'), '# gsd-only\n');

    mkdirSync(join(src, 'patch-coverage-check'), { recursive: true });
    writeFileSync(join(src, 'patch-coverage-check', 'SKILL.md'), '# pcc\n');
    // gsd-only-in-dst is intentionally absent from src.

    copySkillsPull(src, dst);

    // The dst-only gsd-* entry must survive.
    expect(existsSync(join(dst, 'gsd-only-in-dst'))).toBe(true);
    expect(existsSync(join(dst, 'patch-coverage-check'))).toBe(true);
  });

  it('does NOT copy a gsd-* entry from src into dst (defense-in-depth)', () => {
    // A stale gsd-* entry in the repo (from the symlink era) must not be
    // overlaid into the local skills dir on pull.
    mkdirSync(join(src, 'gsd-repo-stale'), { recursive: true });
    writeFileSync(join(src, 'gsd-repo-stale', 'SKILL.md'), '# stale\n');
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');

    copySkillsPull(src, dst);

    expect(existsSync(join(dst, 'gsd-repo-stale'))).toBe(false);
    expect(existsSync(join(dst, 'graphify'))).toBe(true);
  });

  it('creates dst with only non-gsd src entries when dst does not exist (fresh pull)', () => {
    // dst does not exist at all -- first-time pull.
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');
    mkdirSync(join(src, 'gsd-foo'), { recursive: true });
    writeFileSync(join(src, 'gsd-foo', 'SKILL.md'), '# gsd-foo\n');

    expect(existsSync(dst)).toBe(false);
    copySkillsPull(src, dst);

    expect(existsSync(dst)).toBe(true);
    expect(readdirSync(dst).sort()).toEqual(['graphify']);
  });

  it('does not overlay a NEVER_SYNC file nested in src into dst (WR-02)', () => {
    // A poisoned repo carrying a host-config file under a user skill must not
    // restore it onto the host on pull.
    mkdirSync(join(src, 'graphify'), { recursive: true });
    writeFileSync(join(src, 'graphify', 'SKILL.md'), '# graphify\n');
    writeFileSync(join(src, 'graphify', 'settings.local.json'), '{}\n');

    copySkillsPull(src, dst);

    expect(existsSync(join(dst, 'graphify', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'graphify', 'settings.local.json'))).toBe(false);
  });
});

describe('syncSkillsPull', () => {
  let testHome: string;
  let repoUnderHome: string;
  let sharedSkills: string;
  let localSkills: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-sync-skills-pull-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedSkills = join(repoUnderHome, 'shared', 'skills');
    localSkills = join(testHome, '.claude', 'skills');
    mkdirSync(sharedSkills, { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('overlays a user skill from shared/skills into ~/.claude/skills', async () => {
    mkdirSync(join(sharedSkills, 'graphify'), { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    const { syncSkillsPull } = await import('./skills-sync.ts');
    syncSkillsPull('20260101-120000');
    expect(existsSync(join(localSkills, 'graphify'))).toBe(true);
  });

  it('preserves a pre-existing local gsd-* skill on pull', async () => {
    mkdirSync(join(sharedSkills, 'graphify'), { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    mkdirSync(join(localSkills, 'gsd-local'), { recursive: true });
    writeFileSync(join(localSkills, 'gsd-local', 'SKILL.md'), '# gsd-local\n');
    const { syncSkillsPull } = await import('./skills-sync.ts');
    syncSkillsPull('20260101-120000');
    expect(existsSync(join(localSkills, 'gsd-local'))).toBe(true);
    expect(existsSync(join(localSkills, 'graphify'))).toBe(true);
  });

  it('migrates a ~/.claude/skills symlink to a real dir and backs it up', async () => {
    // Simulate the symlink era: ~/.claude/skills is a symlink to shared/skills.
    const backupBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    mkdirSync(backupBase, { recursive: true });
    // Create the symlink target first.
    mkdirSync(join(sharedSkills, 'graphify'), { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    // Create the symlink (pointing anywhere -- just needs to be a symlink).
    symlinkSync(sharedSkills, localSkills);
    expect(lstatSync(localSkills).isSymbolicLink()).toBe(true);
    const { syncSkillsPull } = await import('./skills-sync.ts');
    const ts = '20260101-120000';
    syncSkillsPull(ts);
    // After migration, localSkills must be a real directory, not a symlink.
    const stat = lstatSync(localSkills);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    // A backup entry must exist for the symlink (backupBeforeWrite contract).
    // backupBeforeWrite stores at backupBase/<ts>/<rel> where rel = relative(claudeHome(), absPath).
    // claudeHome() = testHome/.claude, absPath = testHome/.claude/skills, so rel = 'skills'.
    const backupEntry = join(backupBase, ts, 'skills');
    expect(existsSync(backupEntry)).toBe(true);
  });

  it('is idempotent: a second call with localSkills already a real dir does not re-backup', async () => {
    mkdirSync(join(sharedSkills, 'graphify'), { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    mkdirSync(localSkills, { recursive: true });
    const backupBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    mkdirSync(backupBase, { recursive: true });
    const { syncSkillsPull } = await import('./skills-sync.ts');
    const ts = '20260101-120001';
    syncSkillsPull(ts);
    syncSkillsPull(ts);
    // A real dir was never a symlink, so no backup entry for it.
    const backupEntry = join(backupBase, ts, '.claude', 'skills');
    expect(existsSync(backupEntry)).toBe(false);
  });

  it('is a no-op when shared/skills does not exist', async () => {
    // Remove the shared/skills dir so there is nothing to overlay.
    rmSync(sharedSkills, { recursive: true, force: true });
    const { syncSkillsPull } = await import('./skills-sync.ts');
    // Must not throw and must not create localSkills.
    syncSkillsPull('20260101-120000');
    expect(existsSync(localSkills)).toBe(false);
  });
});

describe('syncSkillsPush', () => {
  let testHome: string;
  let repoUnderHome: string;
  let sharedSkills: string;
  let localSkills: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-sync-skills-push-'));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedSkills = join(repoUnderHome, 'shared', 'skills');
    localSkills = join(testHome, '.claude', 'skills');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(localSkills, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies a user skill from ~/.claude/skills into shared/skills', async () => {
    mkdirSync(join(localSkills, 'pr-feedback-sweep'), { recursive: true });
    writeFileSync(join(localSkills, 'pr-feedback-sweep', 'SKILL.md'), '# pr-feedback-sweep\n');
    const { syncSkillsPush } = await import('./skills-sync.ts');
    syncSkillsPush();
    expect(existsSync(join(sharedSkills, 'pr-feedback-sweep'))).toBe(true);
  });

  it('excludes a local gsd-* skill from shared/skills on push', async () => {
    mkdirSync(join(localSkills, 'graphify'), { recursive: true });
    writeFileSync(join(localSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    mkdirSync(join(localSkills, 'gsd-foo'), { recursive: true });
    writeFileSync(join(localSkills, 'gsd-foo', 'SKILL.md'), '# gsd-foo\n');
    const { syncSkillsPush } = await import('./skills-sync.ts');
    syncSkillsPush();
    expect(existsSync(join(sharedSkills, 'graphify'))).toBe(true);
    expect(existsSync(join(sharedSkills, 'gsd-foo'))).toBe(false);
  });

  it('removes a stale gsd-* entry from shared/skills on first push (one-time cleanup)', async () => {
    // A stale gsd-* in the repo from the symlink era must be removed by the
    // push mirror (copySkillsPush uses rm-then-filter).
    mkdirSync(join(sharedSkills, 'gsd-stale'), { recursive: true });
    writeFileSync(join(sharedSkills, 'gsd-stale', 'old.md'), 'stale\n');
    mkdirSync(join(localSkills, 'graphify'), { recursive: true });
    writeFileSync(join(localSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    const { syncSkillsPush } = await import('./skills-sync.ts');
    syncSkillsPush();
    expect(existsSync(join(sharedSkills, 'gsd-stale'))).toBe(false);
    expect(existsSync(join(sharedSkills, 'graphify'))).toBe(true);
  });

  it('is a no-op when ~/.claude/skills does not exist', async () => {
    rmSync(localSkills, { recursive: true, force: true });
    const { syncSkillsPush } = await import('./skills-sync.ts');
    // Must not throw and must not create sharedSkills.
    syncSkillsPush();
    expect(existsSync(sharedSkills)).toBe(false);
  });

  it('does not throw or wipe shared/skills when ~/.claude/skills is still a symlink', async () => {
    // Pre-phase-50 live-symlink state: a host upgraded but not yet pulled has
    // ~/.claude/skills pointing into shared/skills. Pushing through it must not
    // rmSync the symlink's own target and crash (CR-01 regression).
    mkdirSync(sharedSkills, { recursive: true });
    mkdirSync(join(sharedSkills, 'graphify'), { recursive: true });
    writeFileSync(join(sharedSkills, 'graphify', 'SKILL.md'), '# graphify\n');
    rmSync(localSkills, { recursive: true, force: true });
    symlinkSync(sharedSkills, localSkills);
    expect(lstatSync(localSkills).isSymbolicLink()).toBe(true);

    const { syncSkillsPush } = await import('./skills-sync.ts');
    expect(() => syncSkillsPush()).not.toThrow();

    // shared/skills and its content must survive untouched (not wiped).
    expect(existsSync(join(sharedSkills, 'graphify', 'SKILL.md'))).toBe(true);
    // The symlink is left in place for the next pull to migrate.
    expect(lstatSync(localSkills).isSymbolicLink()).toBe(true);
  });
});
