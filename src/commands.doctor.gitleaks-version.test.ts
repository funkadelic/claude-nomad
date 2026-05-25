import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { GITLEAKS_PINNED_VERSION } from './config.ts';
import { reportGitleaksVersionCheck } from './commands.doctor.gitleaks-version.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

// WARN / OK / silent matrix for the gitleaks version-drift reporter (D-02,
// D-03, D-04). The reporter is driven directly with an injected `run` that
// returns crafted Buffers (no real spawn, no vi.doMock), mirroring the
// gh-actions.test.ts style. Assertions are on section.items length and
// substring (the `->` arrow and the status glyphs). process.exitCode is
// captured and restored so every case can assert it stays unset.

/** Build an injected run that returns the given gitleaks version string as a
 * Buffer (the real `gitleaks version` stdout is a bare single-line semver). */
function runReturning(version: string): SpawnSyncFn {
  return () => Buffer.from(`${version}\n`);
}

/** Build an injected run that throws like a missing binary (ENOENT). */
function runThrowingEnoent(): SpawnSyncFn {
  return () => {
    const err = new Error('spawn gitleaks ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

describe('gitleaks version drift check', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('WARNs when the installed minor differs from the pin', () => {
    const s = section('Version');
    // Pin is 8.30.x; 8.31.0 differs at the minor.
    reportGitleaksVersionCheck(s, runReturning('8.31.0'));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(warnGlyph);
    expect(s.items[0]).toContain('->');
    expect(s.items[0]).toContain('8.31.0');
    expect(s.items[0]).toContain(GITLEAKS_PINNED_VERSION);
    expect(process.exitCode).toBeUndefined();
  });

  it('emits an OK line (no WARN) on a patch-only difference', () => {
    const s = section('Version');
    // 8.30.5 vs pinned 8.30.1: same major.minor, patch differs -> OK.
    reportGitleaksVersionCheck(s, runReturning('8.30.5'));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(okGlyph);
    expect(s.items[0]).not.toContain(warnGlyph);
    expect(s.items[0]).not.toContain('->');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits an OK line on an exact match', () => {
    const s = section('Version');
    reportGitleaksVersionCheck(s, runReturning(GITLEAKS_PINNED_VERSION));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain(okGlyph);
    expect(s.items[0]).not.toContain(warnGlyph);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when gitleaks is absent (ENOENT)', () => {
    const s = section('Version');
    reportGitleaksVersionCheck(s, runThrowingEnoent());
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent when the version output is unparseable', () => {
    const s = section('Version');
    reportGitleaksVersionCheck(s, runReturning('not-a-version'));
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent on a two-segment version string (no patch component)', () => {
    const s = section('Version');
    // Anchored regex requires X.Y.Z; a bare "8.30" must not parse.
    reportGitleaksVersionCheck(s, runReturning('8.30'));
    expect(s.items).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });
});
