import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('copyExtras (file-local helper)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    src = join(testHome, 'src-tree');
    dst = join(testHome, 'dst-tree');
    mkdirSync(src, { recursive: true });
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

  it('byte-equal mirror of a plain tree (markdown, JSON, nested text)', async () => {
    writeFileSync(join(src, 'top.md'), '# top\n');
    writeFileSync(join(src, 'top.json'), '{"a":1}\n');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'nested', 'deep.txt'), 'deep-bytes');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readFileSync(join(dst, 'top.md'), 'utf8')).toBe('# top\n');
    expect(readFileSync(join(dst, 'top.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(dst, 'nested', 'deep.txt'), 'utf8')).toBe('deep-bytes');
  });

  it('preserves relative symlink targets verbatim (verbatimSymlinks: true; Pitfall 1)', async () => {
    writeFileSync(join(src, 'target.md'), 'real content\n');
    symlinkSync('target.md', join(src, 'link.md'));

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    // The symlink target must be the original relative string, not rewritten
    // to an absolute path into the source tree (Pitfall 1 mitigation).
    expect(readlinkSync(join(dst, 'link.md'))).toBe('target.md');
  });

  it('propagates empty subdirectories to the destination', async () => {
    mkdirSync(join(src, 'sub', 'empty'), { recursive: true });

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(existsSync(join(dst, 'sub', 'empty'))).toBe(true);
    expect(readdirSync(join(dst, 'sub', 'empty'))).toEqual([]);
  });

  it('mirror semantics: dst-only files are removed (rmSync-then-cpSync)', async () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'stale.md'), 'stale\n');
    writeFileSync(join(src, 'fresh.md'), 'fresh\n');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readdirSync(dst).sort()).toEqual(['fresh.md']);
    expect(readFileSync(join(dst, 'fresh.md'), 'utf8')).toBe('fresh\n');
  });
});
