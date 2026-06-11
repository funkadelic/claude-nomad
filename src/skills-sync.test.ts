import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copySkillsPull, copySkillsPush, isGsdOwned } from './skills-sync.ts';

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
});
