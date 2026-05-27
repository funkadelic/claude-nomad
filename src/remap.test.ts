import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('remapPull (integration)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('backs up prior destination contents to ~/.cache/.../backup/<ts>/ before cpSync overwrite', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'new-session.jsonl'), '{"new":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    writeFileSync(join(encodedDir, 'old-session.jsonl'), '{"old":true}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const backupOld = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'projects',
      '-tmp-foo',
      'old-session.jsonl',
    );
    expect(existsSync(backupOld)).toBe(true);
    expect(readFileSync(backupOld, 'utf8')).toBe('{"old":true}\n');

    expect(existsSync(join(encodedDir, 'new-session.jsonl'))).toBe(true);
    expect(readFileSync(join(encodedDir, 'new-session.jsonl'), 'utf8')).toBe('{"new":true}\n');
    expect(existsSync(join(encodedDir, 'old-session.jsonl'))).toBe(false);
  });

  it('mirrors src into dst (destination-only files are deleted, not merged)', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(sharedProjects, 'foo', 'c.jsonl'), '{"c":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    writeFileSync(join(encodedDir, 'a.jsonl'), '{"a":0}\n');
    writeFileSync(join(encodedDir, 'b.jsonl'), '{"b":1}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const finalFiles = readdirSync(encodedDir).sort();
    expect(finalFiles).toEqual(['a.jsonl', 'c.jsonl']);
    expect(readFileSync(join(encodedDir, 'a.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(encodedDir, 'c.jsonl'), 'utf8')).toBe('{"c":1}\n');
  });

  it('copies 3-level-nested files recursively under <encoded>/', async () => {
    // Regression: 3-level-deep path foo/attachments/sub/deep.bin must
    // survive cpSync recursion.
    const deepSrc = join(sharedProjects, 'foo', 'attachments', 'sub');
    mkdirSync(deepSrc, { recursive: true });
    writeFileSync(join(deepSrc, 'deep.bin'), 'deep-bytes');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const deepDst = join(claudeProjects, '-tmp-foo', 'attachments', 'sub', 'deep.bin');
    expect(existsSync(deepDst)).toBe(true);
    expect(readFileSync(deepDst, 'utf8')).toBe('deep-bytes');
  });

  it('remapPush backs up prior REPO_HOME destination before clobber', async () => {
    // Local encoded dir has fresh sessions; repo already has older sessions
    // for the same logical. Earlier code blindly copied over the repo copy
    // and the only rollback was git history (which doesn't exist until the
    // later commit step). Current behavior snapshots repo-side state to
    // ~/.cache/claude-nomad/backup/<ts>/repo/ before the clobber.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'older.jsonl'), '{"old":true}\n');
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'newer.jsonl'), '{"new":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    remapPush('20260516-000000');

    // Repo side now has the newer file (clobber happened as before).
    expect(existsSync(join(sharedProjects, 'foo', 'newer.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'older.jsonl'))).toBe(false);
    // And the older file lives in the repo-scoped backup root.
    const backupOlder = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'repo',
      'shared',
      'projects',
      'foo',
      'older.jsonl',
    );
    expect(existsSync(backupOlder)).toBe(true);
    expect(readFileSync(backupOlder, 'utf8')).toBe('{"old":true}\n');
  });

  it('skips entries whose host path is the TBD placeholder (no mutation, no backup)', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'should-not-copy.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': 'TBD' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260516-000000')).not.toThrow();

    expect(existsSync(join(claudeProjects, '-tmp-foo'))).toBe(false);
    expect(existsSync(join(claudeProjects, 'TBD'))).toBe(false);
    expect(readdirSync(claudeProjects)).toEqual([]);

    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });
});

describe('remapPull dry-run and unmapped count', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does not write to ~/.claude/projects or backup under dryRun and returns unmapped count', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'b.jsonl'), '{"b":1}\n');
    mkdirSync(join(sharedProjects, 'baz'), { recursive: true });
    writeFileSync(join(sharedProjects, 'baz', 'c.jsonl'), '{"c":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': 'TBD' },
          baz: { 'other-host': '/tmp/baz' },
        },
      }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000', { dryRun: true });

    expect(result.unmapped).toBe(2);
    expect(existsSync(join(claudeProjects, '-tmp-foo'))).toBe(false);
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('default (no opts) returns the same unmapped count AND performs the copy for non-skipped entries', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'b.jsonl'), '{"b":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': 'TBD' },
        },
      }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');

    expect(result.unmapped).toBe(1);
    expect(existsSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'))).toBe(true);
  });

  it('early-return path (no path-map.json) returns unmapped:0', async () => {
    // No path-map.json written.
    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');
    expect(result.unmapped).toBe(0);
  });
});

describe('remapPush dry-run and unmapped count', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does not copy anything under dryRun and returns unmapped + collisions:0', async () => {
    // -tmp-foo is mapped; -tmp-drive-by is not mapped (counts as unmapped).
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(claudeProjects, '-tmp-drive-by'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-drive-by', 'd.jsonl'), '{"d":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000', { dryRun: true });

    expect(result.unmapped).toBe(1);
    expect(result.collisions).toBe(0);
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(false);
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('default (no opts) returns same shape and still performs the copy', async () => {
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(claudeProjects, '-tmp-drive-by'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-drive-by', 'd.jsonl'), '{"d":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');

    expect(result.unmapped).toBe(1);
    expect(result.collisions).toBe(0);
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(true);
  });

  it('early-return path (no path-map.json) returns unmapped:0 and collisions:0', async () => {
    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');
    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
  });

  it('early-return path (path-map present, no local projects dir) returns unmapped:0 and collisions:0', async () => {
    // path-map.json exists so remapPush passes the first early return and
    // builds the reverse map, but `~/.claude/projects/` is absent, so the
    // `!existsSync(localProjects)` guard returns before any directory walk.
    rmSync(claudeProjects, { recursive: true, force: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');
    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
  });

  it('reverse map filters TBD and empty-string host values (push line 103)', async () => {
    // The reverse map in remapPush walks path-map.json's per-host entries
    // and skips any that are empty-string or `'TBD'`. Without the skip, an
    // unmapped host's `TBD` would be encoded to the literal string `'TBD'`
    // and could match a local encoded dir. The test plants a mapped entry
    // plus a TBD entry plus an empty-string entry; only the mapped one
    // participates in the copy, the TBD/empty are filtered out of the
    // reverse map AND therefore neither contribute to the unmapped count
    // (their local encoded dir does not exist) nor to the copy.
    mkdirSync(join(claudeProjects, '-srv-mapped'), { recursive: true });
    writeFileSync(join(claudeProjects, '-srv-mapped', 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          mapped: { 'test-host': '/srv/mapped' },
          placeholder: { 'test-host': 'TBD' },
          blank: { 'test-host': '' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');

    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
    expect(existsSync(join(sharedProjects, 'mapped', 'session.jsonl'))).toBe(true);
    // TBD/blank logicals must not appear in shared/projects/ because they
    // were filtered from the reverse map and never matched any local dir.
    expect(existsSync(join(sharedProjects, 'placeholder'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'blank'))).toBe(false);
  });
});

describe('remapPush collision detection', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-collision-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('throws NomadFatal when two distinct paths encode to the same key', async () => {
    // /tmp/foo/bar and /tmp/foo-bar both encode to -tmp-foo-bar.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);
  });

  it('collision message contains both abspaths, the encoded key, nomad doctor, and path-map.json', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('/tmp/foo/bar');
    expect(msg).toContain('/tmp/foo-bar');
    expect(msg).toContain('-tmp-foo-bar');
    expect(msg).toContain('nomad doctor');
    expect(msg).toContain('path-map.json');
  });

  it('does not write to shared/projects/ when collision is detected', async () => {
    const encodedLocal = join(claudeProjects, '-tmp-foo-bar');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);

    // No content written to shared/projects/
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
    // No backup dir created either
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('does not create the repo shared/projects/ dir when collision is detected', async () => {
    // Remove the pre-created repo destination so we can prove a dying push is
    // fully side-effect-free: collision detection runs before the repoProjects
    // mkdir, so no empty shared/projects/ is left behind.
    rmSync(join(repoUnderHome, 'shared'), { recursive: true, force: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);
    expect(existsSync(sharedProjects)).toBe(false);
    expect(existsSync(join(repoUnderHome, 'shared'))).toBe(false);
  });

  it('throws NomadFatal under dryRun:true when collision is detected', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000', { dryRun: true })).toThrow(NomadFatal);
  });

  it('throws under dryRun:true even when a local dir matches the colliding key', async () => {
    // The exact data-loss scenario: a local encoded dir matching the colliding
    // key exists and a dry-run preview is requested. Detection fails closed
    // before the dryRun branch, so the local transcript is left intact and
    // nothing is staged, even in preview mode.
    const encodedLocal = join(claudeProjects, '-tmp-foo-bar');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000', { dryRun: true })).toThrow(NomadFatal);
    expect(existsSync(join(encodedLocal, 'session.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
  });

  it('reports only the first colliding pair when 3+ paths share an encoded key', async () => {
    // /tmp/foo/bar, /tmp/foo-bar, and /tmp-foo/bar all encode to -tmp-foo-bar.
    // Detection dies on the first colliding pair it meets in insertion order,
    // so the message names alpha and beta and never reaches the third path.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
          gamma: { 'test-host': '/tmp-foo/bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('/tmp/foo/bar');
    expect(msg).toContain('/tmp/foo-bar');
    expect(msg).not.toContain('/tmp-foo/bar');
  });

  it('throws when two logical names map to the same absolute path (would orphan one)', async () => {
    // Two logicals, one host path: only one logical could be pushed and the
    // other's shared/projects/ copy would be silently orphaned, so the push
    // fails closed instead of dropping a logical via last-write-wins.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo' },
          beta: { 'test-host': '/tmp/foo' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('duplicate path in path-map.json');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
    expect(msg).toContain('/tmp/foo');
    // Neither logical was pushed; nothing orphaned.
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
  });
});

// remapPush copies only top-level *.jsonl files at depth 0; non-jsonl
// files at depth 0 are skipped with a log line; subdirectory contents
// traverse unfiltered; the cpSync source-root case is allowed explicitly;
// remapPull stays unfiltered (no regression).
describe('remapPush source-side filter', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-srcfilter-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies top-level *.jsonl files through remapPush', async () => {
    // Baseline contract: the happy path keeps working. A session JSONL at
    // depth 0 must reach the staged tree byte-for-byte.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"role":"user"}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    const dst = join(sharedProjects, 'foo', 'sid-A.jsonl');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"role":"user"}\n');
  });

  it('skips top-level non-jsonl files (.bak, .tmp) with one log line each', async () => {
    // Stray local clutter (.bak from a manual scrub, .tmp from editor
    // crash) must never enter the staged tree. Each skip emits one
    // `ℹ︎ skip <rel>: extension not in allowlist` log line.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"role":"user"}\n');
    writeFileSync(join(encodedLocal, 'sid-A.bak'), 'leaked-secret\n');
    writeFileSync(join(encodedLocal, 'tmp.txt'), 'crash-artifact\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    // The jsonl copies through; the .bak and tmp.txt do not.
    expect(existsSync(join(sharedProjects, 'foo', 'sid-A.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'sid-A.bak'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'foo', 'tmp.txt'))).toBe(false);

    const skipLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('skip') && line.includes('extension not in allowlist'));
    expect(skipLines.length).toBe(2);
    expect(skipLines.some((l) => l.includes('sid-A.bak'))).toBe(true);
    expect(skipLines.some((l) => l.includes('tmp.txt'))).toBe(true);
  });

  it('copies subdirectory contents recursively with no filter at depth >=1', async () => {
    // Sub-trees (subagents/, memory/, tool-results/, future names) keep
    // their existing recursive copyDir behavior. A subagent meta-json or a
    // memory markdown file must flow through; the depth-0 filter must NOT
    // fire on depth >=1 entries.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(encodedLocal, 'subagents'), { recursive: true });
    mkdirSync(join(encodedLocal, 'memory'), { recursive: true });
    writeFileSync(join(encodedLocal, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
    writeFileSync(join(encodedLocal, 'subagents', 'agent-1.meta.json'), '{"meta":true}\n');
    writeFileSync(join(encodedLocal, 'memory', 'notes.md'), '# notes\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    expect(existsSync(join(sharedProjects, 'foo', 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'subagents', 'agent-1.meta.json'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'memory', 'notes.md'))).toBe(true);

    // No skip log lines for depth >=1 entries.
    const skipLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('extension not in allowlist'));
    expect(skipLines.length).toBe(0);
  });

  it('does not log a spurious skip line for the cpSync source-root case', async () => {
    // Pitfall 1: cpSync invokes the filter on srcPath === src first.
    // The callback must return true unconditionally for that case (relative
    // path is the empty string). A naive implementation that splits the
    // empty rel into [''] and applies the depth-0 jsonl-only check would
    // log a bogus `ℹ︎ skip : extension not in allowlist` line and
    // abort the entire copy.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"ok":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    // No skip log line with an empty <rel> field. Match the structural
    // shape "skip : " (skip + space + colon + space) that a buggy
    // empty-rel callback would emit.
    const badSkip = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('ℹ︎ skip : extension not in allowlist'));
    expect(badSkip.length).toBe(0);

    // Dst dir exists and is non-empty (the copy completed).
    expect(existsSync(join(sharedProjects, 'foo'))).toBe(true);
    expect(readdirSync(join(sharedProjects, 'foo')).length).toBeGreaterThan(0);
  });

  it('remapPull stays unfiltered: non-jsonl files in shared/projects/<logical>/ copy to local', async () => {
    // Regression guard: only remapPush gains the source-side filter.
    // remapPull keeps the unfiltered copyDir because the repo side is
    // already curated by the push gate. A future PR that applies
    // copyDirJsonlOnly symmetrically would break this test.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'sid-A.txt'), 'curated\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    remapPull('20260520-000000');

    const dst = join(claudeProjects, '-tmp-foo', 'sid-A.txt');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('curated\n');
  });
});

// Covers remap.ts line 56: `if (!existsSync(src)) continue` in remapPull.
// Lives outside the prior describe blocks because it needs a sandbox where
// the path-map is mapped for this host but the repo's
// shared/projects/<logical>/ source is intentionally missing. Easy to model
// with a fresh fixture.
describe('remapPull skips when repo source is missing for a mapped logical', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-no-src-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    // shared/projects/ exists but the per-logical dir does NOT.
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns unmapped:0 and does not create the encoded local dir when shared/projects/<logical>/ is absent', async () => {
    // path-map maps `ghost` to `/srv/ghost` for this host, BUT there is no
    // shared/projects/ghost/ dir in the repo. The `if (!existsSync(src))
    // continue` branch fires (line 56), no copy happens, the encoded local
    // dir is never created. unmapped stays 0 because the host has a mapping.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { ghost: { 'test-host': '/srv/ghost' } },
      }) + '\n',
    );
    expect(existsSync(join(sharedProjects, 'ghost'))).toBe(false);

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');

    expect(result.unmapped).toBe(0);
    expect(existsSync(join(claudeProjects, '-srv-ghost'))).toBe(false);
  });
});
