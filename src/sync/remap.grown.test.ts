import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestPath } from '../core/config.ts';
import { readManifest, writeManifest } from './manifest.ts';
import { forgetPushed, listGrownLocally } from './remap.grown.ts';

const CHUNK = 64 * 1024;

describe('listGrownLocally', () => {
  let root: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nomad-grown-'));
    src = join(root, 'src');
    dst = join(root, 'dst');
    mkdirSync(src);
    mkdirSync(dst);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a multi-chunk grown file', () => {
    const base = Buffer.alloc(CHUNK * 3 + 10, 'a');
    writeFileSync(join(src, 's.jsonl'), base);
    writeFileSync(join(dst, 's.jsonl'), Buffer.concat([base, Buffer.from('more\n')]));
    expect([...listGrownLocally(src, dst)]).toEqual(['s.jsonl']);
  });

  it('does not keep a multi-chunk file that diverges in the last repo chunk', () => {
    const base = Buffer.alloc(CHUNK * 3 + 10, 'a');
    const local = Buffer.concat([base, Buffer.from('more\n')]);
    local[CHUNK * 3 + 5] = 'z'.charCodeAt(0);
    writeFileSync(join(src, 's.jsonl'), base);
    writeFileSync(join(dst, 's.jsonl'), local);
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('does not keep equal-size or smaller local files', () => {
    writeFileSync(join(src, 'eq.jsonl'), 'AB');
    writeFileSync(join(dst, 'eq.jsonl'), 'AB');
    writeFileSync(join(src, 'small.jsonl'), 'ABC');
    writeFileSync(join(dst, 'small.jsonl'), 'AB');
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('does not keep when the local entry is a directory or absent', () => {
    writeFileSync(join(src, 'dir.jsonl'), 'A');
    mkdirSync(join(dst, 'dir.jsonl'));
    writeFileSync(join(src, 'gone.jsonl'), 'A');
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('returns nothing when the repo entry is not a real directory', () => {
    const file = join(root, 'file');
    writeFileSync(file, 'A');
    expect(listGrownLocally(file, dst).size).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('never follows a repo-side symlink', () => {
    writeFileSync(join(root, 'target'), 'A');
    symlinkSync(join(root, 'target'), join(src, 'link.jsonl'));
    writeFileSync(join(dst, 'link.jsonl'), 'AAAA');
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('ignores non-jsonl files', () => {
    writeFileSync(join(src, 'n.md'), 'A');
    writeFileSync(join(dst, 'n.md'), 'AB');
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('returns an empty set when the dst root is absent', () => {
    writeFileSync(join(src, 's.jsonl'), 'A');
    expect(listGrownLocally(src, join(root, 'nope')).size).toBe(0);
  });

  it('skips repo subdirs whose local counterpart is absent or a regular file', () => {
    mkdirSync(join(src, 'missing'));
    writeFileSync(join(src, 'missing', 'a.jsonl'), 'A');
    mkdirSync(join(src, 'flat'));
    writeFileSync(join(src, 'flat', 'a.jsonl'), 'A');
    writeFileSync(join(dst, 'flat'), 'AAAA');
    expect(listGrownLocally(src, dst).size).toBe(0);
  });

  it('keys nested grown files by src-relative path', () => {
    mkdirSync(join(src, 'subagents'));
    mkdirSync(join(dst, 'subagents'));
    writeFileSync(join(src, 'subagents', 'a.jsonl'), 'A\n');
    writeFileSync(join(dst, 'subagents', 'a.jsonl'), 'A\nB\n');
    expect([...listGrownLocally(src, dst)]).toEqual([join('subagents', 'a.jsonl')]);
  });
});

describe('forgetPushed', () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  // home() reads USERPROFILE on win32, so both must point at the temp dir.
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nomad-forget-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const entry = { size: 1, mtime: 1, hash: 'h' };

  it('drops the kept paths and leaves the rest', () => {
    writeManifest(manifestPath(), {
      schema: 1,
      scannerVersion: 'v',
      configHash: 'c',
      files: { '/a.jsonl': entry, '/b.jsonl': entry },
    });
    forgetPushed(['/a.jsonl']);
    expect(Object.keys(readManifest(manifestPath())?.files ?? {})).toEqual(['/b.jsonl']);
  });

  it('writes nothing when no manifest exists or nothing was kept', () => {
    forgetPushed(['/a.jsonl']);
    forgetPushed([]);
    expect(existsSync(manifestPath())).toBe(false);
  });
});
