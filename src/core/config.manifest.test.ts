import { basename } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOST, manifestPath, settingsWrittenPath, sharedBaselinePath } from './config.ts';

/**
 * Behavior tests for `manifestPath()`. Asserts the per-host manifest file
 * path convention and the call-time HOME resolution that allows Stryker
 * worker-thread HOME swaps to take effect without `vi.resetModules()`.
 */
describe('manifestPath', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('returns a path ending in push-manifest-<HOST>.json under .cache/claude-nomad', () => {
    const p = manifestPath();
    expect(p).toContain('.cache');
    expect(p).toContain('claude-nomad');
    expect(p.endsWith(`push-manifest-${encodeURIComponent(HOST)}.json`)).toBe(true);
  });

  it('reflects a mid-process HOME swap without resetModules', () => {
    // Assert on the swapped segment only, not a leading `/`: `join()` (used by
    // manifestPath's `home()` call) normalizes to the native separator, so a
    // posix-literal HOME like `/home/original` renders with backslashes on
    // win32.
    process.env.HOME = '/home/original';
    const p1 = manifestPath();
    process.env.HOME = '/home/swapped';
    const p2 = manifestPath();
    expect(p1).toContain('original');
    expect(p2).toContain('swapped');
    expect(p1).not.toBe(p2);
  });

  it('embeds HOST in the filename so different hosts do not share a manifest', () => {
    const p = manifestPath();
    expect(basename(p)).toBe(`push-manifest-${encodeURIComponent(HOST)}.json`);
  });
});

/**
 * Behavior tests for `sharedBaselinePath()`. Asserts the same two properties the
 * `manifestPath` block asserts, because the baseline shares its conventions: a
 * per-host filename (two hosts sharing a filesystem must never read each other's
 * record of what was materialized locally) and call-time HOME resolution.
 */
describe('sharedBaselinePath', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('returns a per-host shared-baseline filename under .cache/claude-nomad', () => {
    const p = sharedBaselinePath();
    expect(p).toContain('.cache');
    expect(p).toContain('claude-nomad');
    expect(basename(p)).toBe(`shared-baseline-${encodeURIComponent(HOST)}.json`);
  });

  it('reflects a mid-process HOME swap without resetModules', () => {
    // Assert on the swapped segment only, not a leading `/`: `join()` normalizes
    // to the native separator, so a posix-literal HOME renders with backslashes
    // on win32.
    process.env.HOME = '/home/original';
    const p1 = sharedBaselinePath();
    process.env.HOME = '/home/swapped';
    const p2 = sharedBaselinePath();
    expect(p1).toContain('original');
    expect(p2).toContain('swapped');
    expect(p1).not.toBe(p2);
  });

  it('does not collide with the push manifest path', () => {
    expect(sharedBaselinePath()).not.toBe(manifestPath());
  });
});

/**
 * Behavior tests for `settingsWrittenPath()`. Same conventions as
 * `manifestPath`/`sharedBaselinePath`: a per-host filename and call-time
 * HOME resolution.
 */
describe('settingsWrittenPath', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('embeds HOST under <home>/.cache/claude-nomad/', () => {
    const p = settingsWrittenPath();
    expect(p).toContain('.cache');
    expect(p).toContain('claude-nomad');
    expect(basename(p)).toBe(`settings-written-${encodeURIComponent(HOST)}.json`);
  });

  it('reflects a mid-process HOME swap without resetModules', () => {
    process.env.HOME = '/home/original';
    const p1 = settingsWrittenPath();
    process.env.HOME = '/home/swapped';
    const p2 = settingsWrittenPath();
    expect(p1).toContain('original');
    expect(p2).toContain('swapped');
    expect(p1).not.toBe(p2);
  });

  it('encodes a HOST holding a path separator so it cannot escape the filename slot', async () => {
    const original = process.env.NOMAD_HOST;
    process.env.NOMAD_HOST = 'evil/host';
    vi.resetModules();
    try {
      const { settingsWrittenPath: freshPath } = await import('./config.ts');
      const p = freshPath();
      expect(p).not.toContain('evil/host');
      expect(basename(p)).toBe(`settings-written-${encodeURIComponent('evil/host')}.json`);
    } finally {
      if (original !== undefined) process.env.NOMAD_HOST = original;
      else delete process.env.NOMAD_HOST;
      vi.resetModules();
    }
  });
});
