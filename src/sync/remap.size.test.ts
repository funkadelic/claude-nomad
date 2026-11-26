import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { applySelective, copyDirJsonlOnly } from './remap.ts';
import { skipOversize } from './remap.size.ts';

/** Test cap: 1 MiB, so fixtures stay small on every platform. */
const CAP = 1024 * 1024;
const OVER = CAP + CAP / 2;

describe('per-file size cap', () => {
  let root: string;
  let src: string;
  let dst: string;
  let errSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  /** Write `n` zero bytes at `rel` under `base`, creating parents. */
  const put = (base: string, rel: string, n: number): string => {
    const p = join(base, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(n));
    return p;
  };
  /** Text of every console.error call, joined. */
  const warned = (): string => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nomad-remap-size-'));
    src = join(root, 'src');
    dst = join(root, 'repo', 'foo');
    mkdirSync(src, { recursive: true });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe('skipOversize', () => {
    it('keeps a file of exactly the cap, silently', () => {
      const p = put(src, 'a.jsonl', CAP);
      expect(skipOversize(p, 'foo/a.jsonl', CAP)).toBe(false);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('skips a file one byte over the cap with one warning', () => {
      const p = put(src, 'a.jsonl', CAP + 1);
      expect(skipOversize(p, 'foo/a.jsonl', CAP)).toBe(true);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(warned()).toContain(
        'skip foo/a.jsonl: 2 MiB is over the 1 MiB per-file limit GitHub accepts; it stays on this machine only',
      );
    });

    it('never skips a directory', () => {
      mkdirSync(join(src, 'sub'));
      expect(skipOversize(join(src, 'sub'), 'foo/sub', 0)).toBe(false);
    });

    it('uses the 100 MiB default cap', () => {
      const p = put(src, 'a.jsonl', 8);
      expect(skipOversize(p, 'foo/a.jsonl')).toBe(false);
    });
  });

  describe('copyDirJsonlOnly', () => {
    it('leaves out an over-cap root file and copies the small one', () => {
      put(src, 'big.jsonl', OVER);
      put(src, 'small.jsonl', 8);
      copyDirJsonlOnly(src, dst, CAP);
      expect(existsSync(join(dst, 'big.jsonl'))).toBe(false);
      expect(readFileSync(join(dst, 'small.jsonl'))).toHaveLength(8);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(warned()).toContain(`skip ${join('foo', 'big.jsonl')}: 2 MiB`);
    });

    it('leaves out over-cap nested files and copies small siblings', () => {
      put(src, join('sid-1', 'subagents', 'agent-x.jsonl'), OVER);
      put(src, join('sid-1', 'tool-results', 'out.txt'), OVER);
      put(src, join('sid-1', 'subagents', 'agent-y.jsonl'), 8);
      copyDirJsonlOnly(src, dst, CAP);
      expect(existsSync(join(dst, 'sid-1', 'subagents', 'agent-x.jsonl'))).toBe(false);
      expect(existsSync(join(dst, 'sid-1', 'tool-results', 'out.txt'))).toBe(false);
      expect(existsSync(join(dst, 'sid-1', 'subagents', 'agent-y.jsonl'))).toBe(true);
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(warned()).toContain(join('foo', 'sid-1', 'subagents', 'agent-x.jsonl'));
      expect(warned()).toContain(join('foo', 'sid-1', 'tool-results', 'out.txt'));
    });

    it('copies files at and under the cap with no warning', () => {
      put(src, 'at-cap.jsonl', CAP);
      put(src, 'under.jsonl', CAP - 1);
      copyDirJsonlOnly(src, dst, CAP);
      expect(readFileSync(join(dst, 'at-cap.jsonl'))).toHaveLength(CAP);
      expect(readFileSync(join(dst, 'under.jsonl'))).toHaveLength(CAP - 1);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('still reports root clutter under the cap as not in the allowlist', () => {
      put(src, 'sid-A.bak', 8);
      copyDirJsonlOnly(src, dst, CAP);
      expect(existsSync(join(dst, 'sid-A.bak'))).toBe(false);
      expect(errSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'skip sid-A.bak: extension not in allowlist',
      );
    });
  });

  describe('applySelective', () => {
    it('skips an over-cap changed file and copies the small one', () => {
      const big = put(src, 'big.jsonl', OVER);
      const small = put(src, 'small.jsonl', 8);
      applySelective({ changed: new Set([big, small]), deleted: [] }, src, dst, CAP);
      expect(existsSync(join(dst, 'big.jsonl'))).toBe(false);
      expect(existsSync(join(dst, 'small.jsonl'))).toBe(true);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(warned()).toContain(`skip ${join('foo', 'big.jsonl')}: 2 MiB`);
    });

    it('leaves an existing repo copy of a skipped file untouched', () => {
      const big = put(src, 'big.jsonl', OVER);
      mkdirSync(dst, { recursive: true });
      writeFileSync(join(dst, 'big.jsonl'), 'older');
      applySelective({ changed: new Set([big]), deleted: [] }, src, dst, CAP);
      expect(readFileSync(join(dst, 'big.jsonl'), 'utf8')).toBe('older');
    });

    it('copies a changed file of exactly the cap with no warning', () => {
      const p = put(src, 'at-cap.jsonl', CAP);
      applySelective({ changed: new Set([p]), deleted: [] }, src, dst, CAP);
      expect(readFileSync(join(dst, 'at-cap.jsonl'))).toHaveLength(CAP);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });
});
