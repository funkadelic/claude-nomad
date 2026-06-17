import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupBeforeWrite, backupRepoWrite } from './utils.fs.ts';

/**
 * claudeHome() / backupBase() backup-helper coverage, split off from
 * utils.test.ts to mirror utils.fs.ts and keep file sizes under the
 * ~200-line cap. The explicit-projectRoot backupExtrasWrite cases live in
 * the sibling utils.fs.backup-extras.test.ts. SUT loads from ./utils.fs.ts.
 */

describe('backupBeforeWrite', () => {
  let originalHome: string | undefined;
  let testHome: string;
  const ts = '20260516-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies an existing file under claudeHome() to the backup dir byte-equal', () => {
    const src = join(testHome, '.claude', 'settings.json');
    writeFileSync(src, '{"a":1}');
    backupBeforeWrite(src, ts);
    const dst = join(testHome, '.cache', 'claude-nomad', 'backup', ts, 'settings.json');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"a":1}');
  });

  it('is a no-op when the source path does not exist', () => {
    const src = join(testHome, '.claude', 'settings.json');
    backupBeforeWrite(src, ts);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  it('refuses paths outside claudeHome()', () => {
    mkdirSync(join(testHome, '.other'), { recursive: true });
    const src = join(testHome, '.other', 'data.json');
    writeFileSync(src, '{"a":1}');
    backupBeforeWrite(src, ts);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  it('backs up an entry whose name begins with ".." (not treated as an escape)', () => {
    // Regression: the segment-boundary escape guard must allow a legitimate
    // sibling whose name merely starts with ".." (e.g. "..config"); the prior
    // bare startsWith("..") wrongly skipped it.
    const src = join(testHome, '.claude', '..config');
    writeFileSync(src, 'cfg');
    backupBeforeWrite(src, ts);
    const dst = join(testHome, '.cache', 'claude-nomad', 'backup', ts, '..config');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('cfg');
  });

  it('recursively copies a directory under claudeHome()', () => {
    const agentsDir = join(testHome, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'foo.md'), 'foo');
    writeFileSync(join(agentsDir, 'bar.md'), 'bar');
    backupBeforeWrite(agentsDir, ts);
    const backupAgents = join(testHome, '.cache', 'claude-nomad', 'backup', ts, 'agents');
    expect(readFileSync(join(backupAgents, 'foo.md'), 'utf8')).toBe('foo');
    expect(readFileSync(join(backupAgents, 'bar.md'), 'utf8')).toBe('bar');
  });
});

describe('backupRepoWrite', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let repoHome: string;
  const ts = '20260516-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-repo-backup-'));
    process.env.HOME = testHome;
    repoHome = join(testHome, 'claude-nomad');
    mkdirSync(repoHome, { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies a repo-scoped file to the repo subdir of the backup root', () => {
    const src = join(repoHome, 'shared', 'projects', 'foo', 'session.jsonl');
    mkdirSync(join(repoHome, 'shared', 'projects', 'foo'), { recursive: true });
    writeFileSync(src, '{"a":1}');
    backupRepoWrite(src, ts, repoHome);
    const dst = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      ts,
      'repo',
      'shared',
      'projects',
      'foo',
      'session.jsonl',
    );
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"a":1}');
  });

  it('is a no-op when the source path does not exist', () => {
    const src = join(repoHome, 'shared', 'projects', 'missing');
    backupRepoWrite(src, ts, repoHome);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  it('refuses paths outside the repoHome argument', () => {
    const outsidePath = join(testHome, 'elsewhere.json');
    writeFileSync(outsidePath, '{"a":1}');
    backupRepoWrite(outsidePath, ts, repoHome);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });
});
