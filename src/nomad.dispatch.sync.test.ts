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
  it('bare sync (no flags) returns { dryRun: false }', () => {
    expect(parseSyncArgs(argv())).toEqual({ dryRun: false });
  });

  it('sync --dry-run returns { dryRun: true }', () => {
    expect(parseSyncArgs(argv('--dry-run'))).toEqual({ dryRun: true });
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
});
