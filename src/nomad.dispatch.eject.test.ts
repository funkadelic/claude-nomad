import { describe, expect, it } from 'vitest';

import { parseEjectArgs } from './nomad.dispatch.eject.ts';

/**
 * Build a minimal argv array matching what Node passes to a running script.
 * Elements 0-2 are `['node', 'nomad.ts', 'eject']`; remaining elements are
 * the user-supplied tokens.
 */
function argv(...tokens: string[]): string[] {
  return ['node', 'nomad.ts', 'eject', ...tokens];
}

describe('parseEjectArgs', () => {
  it('bare eject (no flags) returns { dryRun: false }', () => {
    expect(parseEjectArgs(argv())).toEqual({ dryRun: false });
  });

  it('eject --dry-run returns { dryRun: true }', () => {
    expect(parseEjectArgs(argv('--dry-run'))).toEqual({ dryRun: true });
  });

  it('duplicate --dry-run returns null', () => {
    expect(parseEjectArgs(argv('--dry-run', '--dry-run'))).toBeNull();
  });

  it('unknown flag returns null', () => {
    expect(parseEjectArgs(argv('--bogus'))).toBeNull();
  });

  it('extra positional argument returns null', () => {
    expect(parseEjectArgs(argv('extra-positional'))).toBeNull();
  });

  it('unknown flag after --dry-run returns null', () => {
    expect(parseEjectArgs(argv('--dry-run', '--unknown'))).toBeNull();
  });
});
