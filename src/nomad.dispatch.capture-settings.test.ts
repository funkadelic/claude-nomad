import { describe, expect, it } from 'vitest';

import { parseCaptureSettingsArgs } from './nomad.dispatch.capture-settings.ts';

describe('parseCaptureSettingsArgs', () => {
  const base = ['node', 'nomad.ts', 'capture-settings'];

  it('returns defaults when no flags are provided', () => {
    expect(parseCaptureSettingsArgs(base)).toEqual({ host: false, dryRun: false, yes: false });
  });

  it('sets host=true for --host', () => {
    expect(parseCaptureSettingsArgs([...base, '--host'])).toEqual({
      host: true,
      dryRun: false,
      yes: false,
    });
  });

  it('sets dryRun=true for --dry-run', () => {
    expect(parseCaptureSettingsArgs([...base, '--dry-run'])).toEqual({
      host: false,
      dryRun: true,
      yes: false,
    });
  });

  it('sets yes=true for --yes', () => {
    expect(parseCaptureSettingsArgs([...base, '--yes'])).toEqual({
      host: false,
      dryRun: false,
      yes: true,
    });
  });

  it('sets yes=true for the -y alias', () => {
    expect(parseCaptureSettingsArgs([...base, '-y'])).toEqual({
      host: false,
      dryRun: false,
      yes: true,
    });
  });

  it('accepts --host, --dry-run, and --yes in any order', () => {
    expect(parseCaptureSettingsArgs([...base, '--host', '--dry-run', '--yes'])).toEqual({
      host: true,
      dryRun: true,
      yes: true,
    });
    expect(parseCaptureSettingsArgs([...base, '--yes', '--dry-run', '--host'])).toEqual({
      host: true,
      dryRun: true,
      yes: true,
    });
  });

  it('returns null for a duplicate --host', () => {
    expect(parseCaptureSettingsArgs([...base, '--host', '--host'])).toBeNull();
  });

  it('returns null for a duplicate --dry-run', () => {
    expect(parseCaptureSettingsArgs([...base, '--dry-run', '--dry-run'])).toBeNull();
  });

  it('returns null for a duplicate --yes (including the -y alias)', () => {
    expect(parseCaptureSettingsArgs([...base, '--yes', '--yes'])).toBeNull();
    expect(parseCaptureSettingsArgs([...base, '--yes', '-y'])).toBeNull();
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
