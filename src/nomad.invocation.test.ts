import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

/**
 * The shebang the published bin (dist/nomad.mjs) ships. Plain compiled JS needs
 * no type-stripping flags, so a bare `node` shebang is correct.
 */
const EXPECTED_SHEBANG = '#!/usr/bin/env node';

/**
 * Resolves the absolute path to the bin source entrypoint (src/nomad.ts)
 * relative to this test file, independent of the process working directory.
 */
function nomadEntry(): string {
  return fileURLToPath(new URL('./nomad.ts', import.meta.url));
}

/**
 * Reads and parses the package.json at the repository root, resolved relative
 * to this test file so the test is independent of the process working directory.
 */
function readPackageJson(): { bin: Record<string, string> } {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  return parsed as { bin: Record<string, string> };
}

describe('nomad bin distribution', () => {
  // Regression guard for the node_modules type-stripping crash: the published
  // bin MUST be a compiled .mjs under dist/, never a raw src/*.ts. Node refuses
  // to type-strip files under node_modules, so a .ts bin crashes on every
  // `npm i -g` invocation (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
  it('points bin at a compiled .mjs bundle under dist/, not raw TypeScript', () => {
    const { bin } = readPackageJson();
    expect(bin.nomad).toMatch(/^\.\/dist\/.+\.mjs$/);
    expect(bin.nomad).not.toMatch(/\.ts$/);
  });

  // Byte-stable invariant on the dev entry: exit 0, bare semver on stdout, empty
  // stderr (no ExperimentalWarning leak) under the experimental-warning flag.
  it('prints bare semver to stdout with empty stderr (dev entry)', () => {
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', nomadEntry(), '--version'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Faithful end-to-end guard: bundle the entry exactly as scripts/build.mjs
  // does, then run the artifact as plain JS. This is the contract a published
  // `npm i -g` install relies on, and it would have caught the raw-.ts bin ship.
  it('runs as a bundled plain-JS artifact with the node shebang', async () => {
    const { build } = await import('esbuild');
    const dir = mkdtempSync(join(tmpdir(), 'nomad-bin-'));
    const outfile = join(dir, 'nomad.mjs');
    try {
      await build({
        entryPoints: [nomadEntry()],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile,
        banner: { js: EXPECTED_SHEBANG },
        logLevel: 'silent',
      });
      expect(readFileSync(outfile, 'utf8').split('\n')[0]).toBe(EXPECTED_SHEBANG);
      const result = spawnSync(process.execPath, [outfile, '--version'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
