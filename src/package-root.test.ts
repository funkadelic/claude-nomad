import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageRoot } from './package-root.ts';

describe('packageRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-pkgroot-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the starting directory when it holds the package.json', () => {
    writeFileSync(join(tmp, 'package.json'), '{}\n');
    expect(packageRoot(tmp)).toBe(tmp);
  });

  it('walks up past intermediate directories that hold no package.json', () => {
    writeFileSync(join(tmp, 'package.json'), '{}\n');
    const nested = join(tmp, 'src', 'commands', 'doctor');
    mkdirSync(nested, { recursive: true });
    expect(packageRoot(nested)).toBe(tmp);
  });

  it('stops at the nearest package.json rather than the outermost one', () => {
    writeFileSync(join(tmp, 'package.json'), '{}\n');
    const inner = join(tmp, 'vendor', 'thing');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'package.json'), '{}\n');
    const deeper = join(inner, 'src');
    mkdirSync(deeper);
    expect(packageRoot(deeper)).toBe(inner);
  });

  it('throws when no ancestor holds a package.json', () => {
    const orphan = join(tmp, 'orphan');
    mkdirSync(orphan);
    expect(() => packageRoot(orphan)).toThrow(/no package\.json above/);
  });

  it('defaults to this module own directory, finding the repo package.json', () => {
    // No argument: the walk starts at src/ and must reach the repo root, which
    // is the property the doctor version and engine rows depend on.
    const here = dirname(fileURLToPath(import.meta.url));
    expect(packageRoot()).toBe(join(here, '..'));
  });
});
