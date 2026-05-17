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

  it('copies 3-level-nested files recursively under <encoded>/ (FMT-01 regression)', async () => {
    // FMT-01 regression: 3-level-deep path foo/attachments/sub/deep.bin must survive cpSync recursion.
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
