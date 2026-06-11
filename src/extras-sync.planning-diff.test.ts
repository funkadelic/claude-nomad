import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NomadFatal } from './utils.ts';

/**
 * Unit tests for parsePlanningDiff and planningDeleteTargets.
 * Tests are behavior-focused: given raw git diff --name-status -z output,
 * assert the classification and path derivation results.
 */

describe('parsePlanningDiff', () => {
  it('returns empty arrays for empty raw input', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const result = parsePlanningDiff('');
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('classifies M record as changed', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'M\0shared/extras/foo/.planning/STATE.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain('shared/extras/foo/.planning/STATE.md');
    expect(result.deleted).toEqual([]);
  });

  it('classifies A record as changed', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'A\0shared/extras/foo/.planning/new.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain('shared/extras/foo/.planning/new.md');
    expect(result.deleted).toEqual([]);
  });

  it('classifies D record as deleted', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/foo/.planning/old.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.deleted).toContain('shared/extras/foo/.planning/old.md');
    expect(result.changed).toEqual([]);
  });

  it('classifies rename record (R100) as deleted old + changed new', async () => {
    // A rename record (status starts with R) consumes TWO path fields:
    // old-name is deleted, new-name is changed.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'R100\0shared/extras/foo/.planning/a.md\0shared/extras/foo/.planning/b.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.deleted).toContain('shared/extras/foo/.planning/a.md');
    expect(result.changed).toContain('shared/extras/foo/.planning/b.md');
  });

  it('classifies copy record (C100) as changed dst only (src not deleted)', async () => {
    // A copy record (status starts with C) consumes TWO path fields:
    // src is NOT deleted, dst is changed.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'C100\0shared/extras/foo/.planning/src.md\0shared/extras/foo/.planning/dst.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain('shared/extras/foo/.planning/dst.md');
    expect(result.deleted).not.toContain('shared/extras/foo/.planning/src.md');
  });

  it('handles multiple records in a single raw string', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = [
      'M\0shared/extras/foo/.planning/STATE.md\0',
      'D\0shared/extras/foo/.planning/old.md\0',
      'A\0shared/extras/foo/.planning/new.md\0',
    ].join('');
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain('shared/extras/foo/.planning/STATE.md');
    expect(result.changed).toContain('shared/extras/foo/.planning/new.md');
    expect(result.deleted).toContain('shared/extras/foo/.planning/old.md');
  });

  it('passes paths with spaces verbatim (NUL-delimited, no escaping)', async () => {
    // NUL-delimited parsing means spaces and non-ASCII bytes pass through
    // without any octal unescaping (Phase 41 CR-01 lesson).
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const pathWithSpace = 'shared/extras/foo/.planning/my plan.md';
    const raw = 'M\0' + pathWithSpace + '\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain(pathWithSpace);
  });

  it('passes non-ASCII bytes verbatim (NUL-delimited, no octal unescaping)', async () => {
    // Non-ASCII paths must survive verbatim; git -z does not quote them.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const nonAsciiPath = 'shared/extras/foo/.planning/café.md';
    const raw = 'A\0' + nonAsciiPath + '\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toContain(nonAsciiPath);
  });

  it('ignores a trailing NUL / empty final field (no empty-string path emitted)', async () => {
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'M\0shared/extras/foo/.planning/a.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed.some((p) => p === '')).toBe(false);
    expect(result.deleted.some((p) => p === '')).toBe(false);
  });
});

describe('planningDeleteTargets', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nomad-planning-diff-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the host-side absolute path for a deleted .planning file', async () => {
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/my-proj/.planning/STATE.md\0';
    const targets = planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot });
    expect(targets).toContain(join(tmpRoot, '.planning', 'STATE.md'));
  });

  it('ignores a deleted path whose prefix belongs to a different logical', async () => {
    // A path under shared/extras/other-proj/ must not appear in the targets
    // for logical 'my-proj'.
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/other-proj/.planning/STATE.md\0';
    const targets = planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot });
    expect(targets).toEqual([]);
  });

  it('ignores a deleted path that is not under the .planning prefix at all', async () => {
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/my-proj/CLAUDE.md\0';
    const targets = planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot });
    expect(targets).toEqual([]);
  });

  it('FATALs on a poisoned deleted path with .. that would escape localRoot/.planning', async () => {
    // A crafted path like shared/extras/my-proj/.planning/../../../etc/passwd
    // must be rejected with NomadFatal before the path is returned.
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/my-proj/.planning/../../../etc/passwd\0';
    expect(() => planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot })).toThrow(
      NomadFatal,
    );
  });

  it('calls assertSafeLogical and FATALs on a path-traversal logical', async () => {
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'D\0shared/extras/bad/../foo/.planning/a.md\0';
    expect(() => planningDeleteTargets({ raw, logical: '../bad', localRoot: tmpRoot })).toThrow(
      NomadFatal,
    );
  });

  it('returns multiple targets when the raw diff has multiple D records', async () => {
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = [
      'D\0shared/extras/my-proj/.planning/a.md\0',
      'D\0shared/extras/my-proj/.planning/sub/b.md\0',
    ].join('');
    const targets = planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot });
    expect(targets).toContain(join(tmpRoot, '.planning', 'a.md'));
    expect(targets).toContain(join(tmpRoot, '.planning', 'sub', 'b.md'));
  });

  it('returns no targets for changed-only (non-D) records', async () => {
    const { planningDeleteTargets } = await import('./extras-sync.planning-diff.ts');
    const raw = 'M\0shared/extras/my-proj/.planning/STATE.md\0';
    const targets = planningDeleteTargets({ raw, logical: 'my-proj', localRoot: tmpRoot });
    expect(targets).toEqual([]);
  });
});

describe('parsePlanningDiff edge cases (branch coverage)', () => {
  it('handles a truncated rename record with no new-name field', async () => {
    // A malformed rename record that ends after old-name (no new-name NUL field).
    // The oldPath should still be classified as deleted; newPath is undefined.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'R100\0shared/extras/foo/.planning/a.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.deleted).toContain('shared/extras/foo/.planning/a.md');
    // No newPath field present, so changed must be empty.
    expect(result.changed).toEqual([]);
  });

  it('handles a truncated copy record with no dst field', async () => {
    // A malformed copy record with only the src field (no dst NUL field).
    // The dst is undefined and must not be pushed to changed.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    const raw = 'C100\0shared/extras/foo/.planning/src.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('handles a single-path record with no path field (truncated)', async () => {
    // A status token with no following path field (e.g. truncated input).
    // Neither changed nor deleted should receive an entry.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    // A lone status token with no NUL after it (split produces ['M'] with no path).
    const raw = 'M';
    const result = parsePlanningDiff(raw);
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
  });
});

describe('parsePlanningDiff branch coverage (rename empty oldPath)', () => {
  it('skips empty oldPath in rename record (R with empty first path field)', async () => {
    // A rename record where the old-path field is an empty string (malformed).
    // The empty oldPath must not be pushed to deleted.
    const { parsePlanningDiff } = await import('./extras-sync.planning-diff.ts');
    // R100, empty oldPath (NUL NUL), newPath
    const raw = 'R100\0\0shared/extras/foo/.planning/b.md\0';
    const result = parsePlanningDiff(raw);
    expect(result.deleted).toEqual([]);
    expect(result.changed).toContain('shared/extras/foo/.planning/b.md');
  });
});
