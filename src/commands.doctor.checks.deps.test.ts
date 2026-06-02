import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { reportOptionalDeps } from './commands.doctor.checks.deps.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

// Presence/absence/unparseable matrix for reportOptionalDeps (gh + HTTP fetcher).
// The reporter is driven with injected SpawnSyncFn factories (no real spawn).
// process.exitCode is captured and restored so each case asserts independently.

/**
 * Build a SpawnSyncFn that returns realistic --version stdout for `bin` and
 * throws ENOENT for any other binary. The version string is embedded in the
 * typical format for each binary.
 *
 * @param bin - The binary name to simulate as present (e.g. `gh`, `curl`, `wget`).
 * @param version - The version token to embed in the stdout line.
 */
function runPresent(bin: string, version: string): SpawnSyncFn {
  return (b) => {
    if (b === bin) {
      let line: string;
      if (bin === 'curl') {
        line = `curl ${version} (x86_64-pc-linux-gnu) libcurl/${version} OpenSSL/3.0.13\n`;
      } else if (bin === 'wget') {
        line = `GNU Wget ${version} built on linux-gnu.\n`;
      } else {
        line = `gh version ${version} (2025-07-18)\n`;
      }
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
 * Build a SpawnSyncFn that throws ENOENT for all of the listed binaries and
 * returns a version Buffer for any other binary.
 *
 * @param bins - The binary names to simulate as absent.
 */
function runAllAbsent(...bins: string[]): SpawnSyncFn {
  return (b) => {
    if (bins.includes(b)) {
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

  // gh row tests

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
    expect(ghRow).toContain('Actions-drift');
    expect(process.exitCode).toBeUndefined();
  });

  // HTTP fetcher row tests

  it('emits okGlyph + curl version when curl is present (wget absent)', () => {
    const s = section('Version');
    reportOptionalDeps(s, runPresent('curl', '8.5.0'));
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).toContain('8.5.0');
    expect(fetcherRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph + wget version when only wget is present (curl absent)', () => {
    // curl absent, wget present: fetcher row must be OK (not WARN).
    const run: SpawnSyncFn = (b) => {
      if (b === 'curl') throw Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' });
      if (b === 'wget') return Buffer.from('GNU Wget 1.21.4 built on linux-gnu.\n');
      return Buffer.from(`${b} 1.0.0 (present)\n`);
    };
    const s = section('Version');
    reportOptionalDeps(s, run);
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).toContain('1.21.4');
    expect(fetcherRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits exactly one WARN fetcher row when both curl and wget are absent', () => {
    const s = section('Version');
    reportOptionalDeps(s, runAllAbsent('curl', 'wget'));
    const fetcherRows = s.items.filter((item) => item.includes('HTTP fetcher'));
    expect(fetcherRows).toHaveLength(1);
    expect(fetcherRows[0]).toContain(warnGlyph);
    expect(fetcherRows[0]).toContain('--check-schema');
    expect(process.exitCode).toBeUndefined();
  });

  it('never sets process.exitCode when both curl and wget are absent', () => {
    const s = section('Version');
    reportOptionalDeps(s, runAllAbsent('curl', 'wget'));
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph with no crash when fetcher version output is unparseable', () => {
    const s = section('Version');
    reportOptionalDeps(s, runUnparseable('curl'));
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph (present, no version) when curl exists but --version throws non-ENOENT', () => {
    const s = section('Version');
    reportOptionalDeps(s, runNonEnoentError('curl'));
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph (present, no version) when gh exists but --version throws non-ENOENT', () => {
    const s = section('Version');
    reportOptionalDeps(s, runNonEnoentError('gh'));
    const ghRow = s.items.find((item) => item.includes('gh:'));
    expect(ghRow).toBeDefined();
    expect(ghRow).toContain(okGlyph);
    expect(ghRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits warnGlyph for absent gh and okGlyph for present curl independently', () => {
    // gh absent, curl present -- neither probe gates the other
    const s = section('Version');
    reportOptionalDeps(s, runAbsent('gh'));
    expect(s.items).toHaveLength(2);
    const ghRow = s.items.find((item) => item.includes('gh:'));
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(ghRow).toContain(warnGlyph);
    expect(fetcherRow).toContain(okGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits okGlyph (present) when curl absent and wget version output is unparseable', () => {
    // curl absent, wget present with unparseable output: exercises wget.version ?? 'present'.
    const run: SpawnSyncFn = (b) => {
      if (b === 'curl') throw Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' });
      if (b === 'wget') return Buffer.from('GNU Wget: no version info available\n');
      return Buffer.from(`${b} 1.0.0 (present)\n`);
    };
    const s = section('Version');
    reportOptionalDeps(s, run);
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).toContain('present');
    expect(fetcherRow).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('prefers curl version when both curl and wget are present', () => {
    // Both present: curl is preferred (show curl version, not wget version).
    const run: SpawnSyncFn = (b) => {
      if (b === 'curl') return Buffer.from('curl 8.5.0 (x86_64)\n');
      if (b === 'wget') return Buffer.from('GNU Wget 1.21.4 built on linux-gnu.\n');
      return Buffer.from(`${b} 1.0.0 (present)\n`);
    };
    const s = section('Version');
    reportOptionalDeps(s, run);
    const fetcherRow = s.items.find((item) => item.includes('HTTP fetcher'));
    expect(fetcherRow).toBeDefined();
    expect(fetcherRow).toContain(okGlyph);
    expect(fetcherRow).toContain('8.5.0');
    expect(fetcherRow).not.toContain('1.21.4');
    expect(process.exitCode).toBeUndefined();
  });
});
