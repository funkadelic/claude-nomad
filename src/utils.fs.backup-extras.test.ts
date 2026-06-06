import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupExtrasWrite } from './utils.fs.ts';
import { encodePath } from './utils.json.ts';

/**
 * backupExtrasWrite coverage, split off from the utils.fs.backup.test.ts
 * sibling to keep both files under the ~200-line cap. The helper snapshots a
 * path OUTSIDE claudeHome() (project-attached extras live at a project root on
 * the host filesystem) under an explicit projectRoot anchor. SUT loads from
 * ./utils.fs.ts; encodePath loads from ./utils.json.ts.
 */
describe('backupExtrasWrite', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let projectRoot: string;
  let cacheBase: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-backup-extras-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(projectRoot, { recursive: true });
    cacheBase = join(testHome, '.cache', 'claude-nomad', 'backup');
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('snapshots a single file to the extras-prefixed backup root, namespaced by projectRoot', () => {
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(planningDir, { recursive: true });
    const src = join(planningDir, 'PLAN.md');
    writeFileSync(src, '# plan content\n');

    backupExtrasWrite(src, '20260522-100000', projectRoot);

    const backupFile = join(
      cacheBase,
      '20260522-100000',
      'extras',
      encodePath(projectRoot),
      '.planning',
      'PLAN.md',
    );
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, 'utf8')).toBe('# plan content\n');
  });

  it('recursively snapshots a directory tree under the encoded-projectRoot namespace', () => {
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(join(planningDir, 'phases', '01'), { recursive: true });
    writeFileSync(join(planningDir, 'STATE.md'), 'state\n');
    writeFileSync(join(planningDir, 'phases', '01', 'PLAN.md'), 'plan\n');

    backupExtrasWrite(planningDir, '20260522-100001', projectRoot);

    const backupRoot = join(
      cacheBase,
      '20260522-100001',
      'extras',
      encodePath(projectRoot),
      '.planning',
    );
    expect(existsSync(join(backupRoot, 'STATE.md'))).toBe(true);
    expect(readFileSync(join(backupRoot, 'STATE.md'), 'utf8')).toBe('state\n');
    expect(existsSync(join(backupRoot, 'phases', '01', 'PLAN.md'))).toBe(true);
    expect(readFileSync(join(backupRoot, 'phases', '01', 'PLAN.md'), 'utf8')).toBe('plan\n');
  });

  it('does not collide when two projectRoots share the same relative extras path', () => {
    // Without the encodePath(projectRoot) namespace, `backup/<ts>/extras/<rel>`
    // collides whenever two opted-in projects pull simultaneously with the
    // same relative extras tree. `cpSync` runs with `force: false`, so the
    // second snapshot would silently drop and the user would lose recovery
    // coverage for one of the two projects.
    const projectRootB = join(testHome, 'fake-project-b');
    mkdirSync(join(projectRootB, '.planning'), { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'A\n');
    writeFileSync(join(projectRootB, '.planning', 'PLAN.md'), 'B\n');

    backupExtrasWrite(join(projectRoot, '.planning', 'PLAN.md'), '20260522-100004', projectRoot);
    backupExtrasWrite(join(projectRootB, '.planning', 'PLAN.md'), '20260522-100004', projectRootB);

    const aBackup = join(
      cacheBase,
      '20260522-100004',
      'extras',
      encodePath(projectRoot),
      '.planning',
      'PLAN.md',
    );
    const bBackup = join(
      cacheBase,
      '20260522-100004',
      'extras',
      encodePath(projectRootB),
      '.planning',
      'PLAN.md',
    );
    expect(readFileSync(aBackup, 'utf8')).toBe('A\n');
    expect(readFileSync(bBackup, 'utf8')).toBe('B\n');
  });

  it('no-ops when the source path does not exist', () => {
    const missing = join(projectRoot, '.planning', 'never-existed.md');

    expect(() => backupExtrasWrite(missing, '20260522-100002', projectRoot)).not.toThrow();

    expect(existsSync(join(cacheBase, '20260522-100002'))).toBe(false);
  });

  it('no-ops when absPath resolves outside projectRoot', () => {
    // path.relative(projectRoot, '/some/other/path') returns a ..-prefixed
    // string. The helper must detect that and return silently, matching the
    // existing backupBeforeWrite / backupRepoWrite contract.
    const outside = join(testHome, 'unrelated', 'thing.md');
    mkdirSync(join(testHome, 'unrelated'), { recursive: true });
    writeFileSync(outside, 'unrelated\n');

    expect(() => backupExtrasWrite(outside, '20260522-100003', projectRoot)).not.toThrow();

    expect(existsSync(join(cacheBase, '20260522-100003'))).toBe(false);
  });
});
