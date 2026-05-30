import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * The exact shebang the published bin ships. The `-S node` form lets the bin
 * pass `--disable-warning=ExperimentalWarning`, which keeps stderr clean under
 * native type-stripping (Node 24 emits an ExperimentalWarning without it).
 */
const EXPECTED_SHEBANG = '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning';

/**
 * The interpreter flags encoded in the shebang above. The invocation test
 * passes these explicitly so it exercises the same stderr-clean behavior the
 * shebang gives real `nomad` users, on whatever Node version runs the suite.
 */
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

/**
 * Resolves the absolute path to the nomad bin entrypoint (src/nomad.ts)
 * relative to this test file, independent of the process working directory.
 */
function nomadEntry(): string {
  return fileURLToPath(new URL('./nomad.ts', import.meta.url));
}

describe('nomad bin shim invocation', () => {
  // Locks the production contract: if the shebang drifts (e.g. the warning
  // suppression is dropped), this fails before the behavior test even runs.
  it('ships the node shebang that suppresses experimental warnings', () => {
    const shebang = readFileSync(nomadEntry(), 'utf8').split('\n')[0];
    expect(shebang).toBe(EXPECTED_SHEBANG);
  });

  // Byte-stable invariant: exit 0, bare semver on stdout, empty stderr (no
  // ExperimentalWarning leak) under the same interpreter flags the bin uses.
  it('prints bare semver to stdout with empty stderr under the node shebang', () => {
    const result = spawnSync(process.execPath, [...NODE_FLAGS, nomadEntry(), '--version'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
