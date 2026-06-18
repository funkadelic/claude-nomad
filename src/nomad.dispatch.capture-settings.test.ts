import { describe, expect, it } from 'vitest';

import { parseCaptureSettingsArgs } from './nomad.dispatch.capture-settings.ts';

describe('parseCaptureSettingsArgs', () => {
  const base = ['node', 'nomad.ts', 'capture-settings'];

  it('returns defaults when no flags are provided', () => {
    expect(parseCaptureSettingsArgs(base)).toEqual({ host: false, dryRun: false });
  });

  it('sets host=true for --host', () => {
    expect(parseCaptureSettingsArgs([...base, '--host'])).toEqual({ host: true, dryRun: false });
  });

  it('sets dryRun=true for --dry-run', () => {
    expect(parseCaptureSettingsArgs([...base, '--dry-run'])).toEqual({ host: false, dryRun: true });
  });

  it('accepts both --host and --dry-run in any order', () => {
    expect(parseCaptureSettingsArgs([...base, '--host', '--dry-run'])).toEqual({
      host: true,
      dryRun: true,
    });
    expect(parseCaptureSettingsArgs([...base, '--dry-run', '--host'])).toEqual({
      host: true,
      dryRun: true,
    });
  });

  it('returns null for a duplicate --host', () => {
    expect(parseCaptureSettingsArgs([...base, '--host', '--host'])).toBeNull();
  });

  it('returns null for a duplicate --dry-run', () => {
    expect(parseCaptureSettingsArgs([...base, '--dry-run', '--dry-run'])).toBeNull();
  });

  it('returns null for an unknown flag', () => {
    expect(parseCaptureSettingsArgs([...base, '--unknown'])).toBeNull();
  });

  it('returns null for a positional argument', () => {
    expect(parseCaptureSettingsArgs([...base, 'extra'])).toBeNull();
  });

  it('returns null when an unknown token follows valid flags', () => {
    expect(parseCaptureSettingsArgs([...base, '--host', 'extra'])).toBeNull();
  });
});
