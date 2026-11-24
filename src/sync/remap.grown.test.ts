import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listGrownLocally } from './remap.grown.ts';

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

  it('never follows a repo-side symlink', () => {
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
