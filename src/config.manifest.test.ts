import { basename } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOST, manifestPath } from './config.ts';

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
