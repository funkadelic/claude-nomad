import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Sibling file dedicated to in-process coverage of the `enabled=true`
 * branch in `./color.ts` (lines 23-41 truthy side). Picocolors caches its
 * `isColorSupported` flag at top-level module load; the in-process tests in
 * `color.test.ts` only exercise the falsey branch (the smoke test there
 * sets `NO_COLOR=1` before its dynamic import, so picocolors is cached with
 * `isColorSupported=false` for the rest of that worker realm).
 *
 * Vitest's `isolate: true` (default) gives each test file a fresh module
 * graph per worker, so this file gets a fresh picocolors load. We set
 * `FORCE_COLOR=1` (and delete `NO_COLOR`) in `beforeAll` BEFORE any import
 * of `./color.ts`. Picocolors then evaluates `isColorSupported = true`,
 * `enabled` is `true`, and the truthy ternary branch (`enabled ? pc.X(s)`)
 * is hit on every helper call.
 *
 * Sibling to `color.identity.test.ts` (which covers the falsey branch).
 * Together they push `color.ts` branch coverage to 100% in the v8 v8
 * coverage report.
 */

let originalNoColor: string | undefined;
let originalForceColor: string | undefined;

beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  originalForceColor = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
});

afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
});

describe('color helpers truthy branch under FORCE_COLOR=1 (in-process)', () => {
  it('all seven helpers wrap their input with an ANSI escape when picocolors enables color', async () => {
    // Dynamic import lands in v8's instrumented module graph; the truthy
    // branch (line 23-41 `enabled ? pc.X(s)`) gets covered.
    const { red, yellow, green, cyan, blue, dim, bold } = await import('./color.ts');
    // The truthy branch wraps with ANSI; the actual escape codes differ per
    // helper but all contain the standard CSI introducer `\x1b[`. We only
    // need to prove the truthy side ran (i.e., the output is NOT identity).
    for (const fn of [red, yellow, green, cyan, blue, dim, bold]) {
      const out = fn('X');
      expect(out).not.toBe('X');
      expect(out).toContain('X');
      expect(out).toContain('\x1b[');
    }
  });

  it('red specifically wraps with the red SGR code', async () => {
    // Sanity check: picocolors' red is well-defined as \x1b[31m...\x1b[39m.
    const { red } = await import('./color.ts');
    expect(red('X')).toBe('\x1b[31mX\x1b[39m');
  });
});
