import { describe, expect, it } from 'vitest';

import { parseSyncArgs } from './nomad.dispatch.sync.ts';

/**
 * Build a minimal argv array matching what Node passes to a running script.
 * Elements 0-2 are `['node', 'nomad.ts', 'sync']`; remaining elements are the
 * user-supplied tokens.
 */
function argv(...tokens: string[]): string[] {
  return ['node', 'nomad.ts', 'sync', ...tokens];
}

describe('parseSyncArgs', () => {
  it('bare sync (no flags) returns { dryRun: false, verbose: false }', () => {
    expect(parseSyncArgs(argv())).toEqual({ dryRun: false, verbose: false });
  });

  it('sync --dry-run returns { dryRun: true, verbose: false }', () => {
    expect(parseSyncArgs(argv('--dry-run'))).toEqual({ dryRun: true, verbose: false });
  });

  it('sync --verbose returns { dryRun: false, verbose: true }', () => {
    expect(parseSyncArgs(argv('--verbose'))).toEqual({ dryRun: false, verbose: true });
  });

  it('sync --all returns { dryRun: false, verbose: true }', () => {
    expect(parseSyncArgs(argv('--all'))).toEqual({ dryRun: false, verbose: true });
  });

  it('sync -v returns { dryRun: false, verbose: true }', () => {
    expect(parseSyncArgs(argv('-v'))).toEqual({ dryRun: false, verbose: true });
  });

  it('sync --dry-run --verbose composes both flags', () => {
    expect(parseSyncArgs(argv('--dry-run', '--verbose'))).toEqual({
      dryRun: true,
      verbose: true,
    });
  });

  it('sync --verbose --dry-run composes both flags regardless of order', () => {
    expect(parseSyncArgs(argv('--verbose', '--dry-run'))).toEqual({
      dryRun: true,
      verbose: true,
    });
  });

  it('duplicate --dry-run returns null', () => {
    expect(parseSyncArgs(argv('--dry-run', '--dry-run'))).toBeNull();
  });

  it('--force-remote returns null (not passed through to sync)', () => {
    expect(parseSyncArgs(argv('--force-remote'))).toBeNull();
  });

  it('unknown positional argument returns null', () => {
    expect(parseSyncArgs(argv('foo'))).toBeNull();
  });

  it('extra positional after --dry-run returns null', () => {
    expect(parseSyncArgs(argv('--dry-run', 'extra'))).toBeNull();
  });

  it('extra positional after --verbose returns null', () => {
    expect(parseSyncArgs(argv('--verbose', 'extra'))).toBeNull();
  });
});
