import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { copyDirJsonlOnly } from './remap.ts';
import { applySelective } from './remap.selective.ts';
import { skipOversize } from './remap.size.ts';
import { MAX_SESSION_FILE_BYTES } from '../core/config.ts';

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
      expect(skipOversize(p, CAP)).toBe(false);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('skips a file one byte over the cap with one warning', () => {
      const p = put(src, 'a.jsonl', CAP + 1);
      expect(skipOversize(p, CAP)).toBe(true);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(warned()).toContain(
        `not syncing ${p} (2 MiB): GitHub rejects files over 1 MiB, so it stays on this machine`,
      );
    });

    it('never skips a directory', () => {
      mkdirSync(join(src, 'sub'));
      expect(skipOversize(join(src, 'sub'), 0)).toBe(false);
    });

    it('uses the 100 MiB default cap', () => {
      const p = put(src, 'a.jsonl', 0);
      // Sparse, so the boundary fixtures cost no disk.
      truncateSync(p, MAX_SESSION_FILE_BYTES);
      expect(skipOversize(p)).toBe(false);
      truncateSync(p, MAX_SESSION_FILE_BYTES + 1);
      expect(skipOversize(p)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('escapes control characters in the warned path', () => {
      const p = put(src, 'a\nb.jsonl', OVER);
      expect(skipOversize(p, CAP)).toBe(true);
      expect(warned()).toContain(String.raw`a\u000ab.jsonl`);
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
      expect(warned()).toContain(`not syncing ${join(src, 'big.jsonl')} (2 MiB)`);
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
      expect(warned()).toContain(join(src, 'sid-1', 'subagents', 'agent-x.jsonl'));
      expect(warned()).toContain(join(src, 'sid-1', 'tool-results', 'out.txt'));
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
      expect(applySelective({ changed: new Set([big, small]), deleted: [] }, src, dst, CAP)).toBe(
        1,
      );
      expect(existsSync(join(dst, 'big.jsonl'))).toBe(false);
      expect(existsSync(join(dst, 'small.jsonl'))).toBe(true);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(warned()).toContain(`not syncing ${join(src, 'big.jsonl')} (2 MiB)`);
    });

    it('removes an older repo copy of a skipped file, as a full mirror does', () => {
      const big = put(src, 'big.jsonl', OVER);
      mkdirSync(dst, { recursive: true });
      writeFileSync(join(dst, 'big.jsonl'), 'older');
      expect(applySelective({ changed: new Set([big]), deleted: [] }, src, dst, CAP)).toBe(1);
      expect(existsSync(join(dst, 'big.jsonl'))).toBe(false);
    });

    it('returns 0 when every changed file is over the cap and none was in the repo', () => {
      const big = put(src, 'big.jsonl', OVER);
      expect(applySelective({ changed: new Set([big]), deleted: [] }, src, dst, CAP)).toBe(0);
    });

    it.skipIf(process.platform === 'win32')(
      'removes a dangling repo symlink of a deleted file',
      () => {
        mkdirSync(dst, { recursive: true });
        symlinkSync(join(root, 'missing'), join(dst, 'gone.jsonl'));
        const sel = { changed: new Set<string>(), deleted: [join(src, 'gone.jsonl')] };
        expect(applySelective(sel, src, dst, CAP)).toBe(1);
        expect(existsSync(join(dst, 'gone.jsonl'))).toBe(false);
      },
    );

    it('counts a removed repo copy of a deleted source file', () => {
      mkdirSync(dst, { recursive: true });
      writeFileSync(join(dst, 'gone.jsonl'), 'x');
      const sel = {
        changed: new Set<string>(),
        deleted: [join(src, 'gone.jsonl'), join(src, 'never.jsonl')],
      };
      expect(applySelective(sel, src, dst, CAP)).toBe(1);
      expect(existsSync(join(dst, 'gone.jsonl'))).toBe(false);
    });

    it('copies a changed file of exactly the cap with no warning', () => {
      const p = put(src, 'at-cap.jsonl', CAP);
      applySelective({ changed: new Set([p]), deleted: [] }, src, dst, CAP);
      expect(readFileSync(join(dst, 'at-cap.jsonl'))).toHaveLength(CAP);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });
});
