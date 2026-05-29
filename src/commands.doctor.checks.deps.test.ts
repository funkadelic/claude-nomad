import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { reportOptionalDeps } from './commands.doctor.checks.deps.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

// Presence/absence/unparseable matrix for reportOptionalDeps (gh + curl).
// The reporter is driven with injected SpawnSyncFn factories (no real spawn).
// process.exitCode is captured and restored so each case asserts independently.

/**
 * Build a SpawnSyncFn that returns realistic --version stdout for `bin` and
 * throws ENOENT for any other binary. The version string is embedded in the
 * typical format for each binary: `gh version X.Y.Z (...)` / `curl X.Y.Z (...)`.
 *
 * @param bin - The binary name to simulate as present (`gh` or `curl`).
 * @param version - The version token to embed in the stdout line.
 */
function runPresent(bin: string, version: string): SpawnSyncFn {
  return (b) => {
    if (b === bin) {
      const line =
        bin === 'curl'
          ? `curl ${version} (x86_64-pc-linux-gnu) libcurl/${version} OpenSSL/3.0.13\n`
          : `gh version ${version} (2025-07-18)\n`;
      return Buffer.from(line);
    }
    throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: 'ENOENT' });
  };
}

/**
 * Build a SpawnSyncFn that throws an ENOENT-coded error for `bin` and returns
 * a valid version Buffer for any other binary.
 *
 * @param bin - The binary name to simulate as absent.
 */
function runAbsent(bin: string): SpawnSyncFn {
  return (b) => {
    if (b === bin) {
      throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: 'ENOENT' });
    }
    return Buffer.from(`${b} 1.0.0 (present)\n`);
  };
}

/**
 * Build a SpawnSyncFn that returns stdout containing no parseable X.Y.Z token
 * for `bin`, simulating a present-but-version-unparseable binary.
 *
 * @param bin - The binary name to simulate as present with unparseable version output.
 */
function runUnparseable(bin: string): SpawnSyncFn {
  return (b) => {
    if (b === bin) return Buffer.from(`${bin}: no version info available\n`);
    return Buffer.from(`${b} 1.0.0\n`);
  };
}

/**
 * Build a SpawnSyncFn that throws a non-ENOENT error for `bin` (e.g. EACCES),
 * simulating a binary that exists but whose --version invocation fails.
 *
 * @param bin - The binary name to simulate as throwing a non-ENOENT error.
 */
function runNonEnoentError(bin: string): SpawnSyncFn {
  return (b) => {
    if (b === bin) {
      throw Object.assign(new Error(`spawn ${b} EACCES`), { code: 'EACCES' });
    }
    return Buffer.from(`${b} 1.0.0\n`);
  };
}

describe('reportOptionalDeps', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('emits okGlyph + version token when gh is present with parseable version', () => {
    const s = section('Version');
    reportOptionalDeps(s, runPresent('gh', '2.45.0'));
    const ghRow = s.items.find((item) => item.includes('gh:'));
    expect(ghRow).toBeDefined();
    expect(ghRow).toContain(okGlyph);
    expect(ghRow).toContain('2.45.0');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph with no crash when gh version output is unparseable', () => {
    const s = section('Version');
    reportOptionalDeps(s, runUnparseable('gh'));
    const ghRow = s.items.find((item) => item.includes('gh:'));
    expect(ghRow).toBeDefined();
    expect(ghRow).toContain(okGlyph);
    expect(ghRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits warnGlyph with capability hint when gh is absent (ENOENT)', () => {
    const s = section('Version');
    reportOptionalDeps(s, runAbsent('gh'));
    const ghRow = s.items.find((item) => item.includes('gh:'));
    expect(ghRow).toBeDefined();
    expect(ghRow).toContain(warnGlyph);
    expect(ghRow).toContain('nomad init');
    expect(ghRow).toContain('mirror-Actions');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph + version token when curl is present with parseable version', () => {
    const s = section('Version');
    reportOptionalDeps(s, runPresent('curl', '8.5.0'));
    const curlRow = s.items.find((item) => item.includes('curl:'));
    expect(curlRow).toBeDefined();
    expect(curlRow).toContain(okGlyph);
    // Must pick the curl binary version, not a libcurl token from another line
    expect(curlRow).toContain('8.5.0');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph with no crash when curl version output is unparseable', () => {
    const s = section('Version');
    reportOptionalDeps(s, runUnparseable('curl'));
    const curlRow = s.items.find((item) => item.includes('curl:'));
    expect(curlRow).toBeDefined();
    expect(curlRow).toContain(okGlyph);
    expect(curlRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits warnGlyph with capability hint when curl is absent (ENOENT)', () => {
    const s = section('Version');
    reportOptionalDeps(s, runAbsent('curl'));
    const curlRow = s.items.find((item) => item.includes('curl:'));
    expect(curlRow).toBeDefined();
    expect(curlRow).toContain(warnGlyph);
    expect(curlRow).toContain('--check-schema');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph (present, no version) when binary exists but --version throws non-ENOENT', () => {
    const s = section('Version');
    reportOptionalDeps(s, runNonEnoentError('gh'));
    const ghRow = s.items.find((item) => item.includes('gh:'));
    expect(ghRow).toBeDefined();
    expect(ghRow).toContain(okGlyph);
    expect(ghRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits warnGlyph for absent binary and okGlyph for present binary independently', () => {
    // gh absent, curl present -- neither probe gates the other
    const s = section('Version');
    reportOptionalDeps(s, runAbsent('gh'));
    expect(s.items).toHaveLength(2);
    const ghRow = s.items.find((item) => item.includes('gh:'));
    const curlRow = s.items.find((item) => item.includes('curl:'));
    expect(ghRow).toContain(warnGlyph);
    expect(curlRow).toContain(okGlyph);
    expect(process.exitCode).toBeUndefined();
  });
});
