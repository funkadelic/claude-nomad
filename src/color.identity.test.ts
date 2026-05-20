import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Sibling file dedicated to in-process coverage of the `enabled=false`
 * identity branch in `./color.ts` (lines 23-41). Picocolors caches its
 * `isColorSupported` flag at top-level module load; once any test file has
 * loaded `./color.ts` (and therefore picocolors) with the ambient env,
 * `vi.resetModules()` cannot re-evaluate picocolors' captured static.
 *
 * Vitest loads each test file in a clean module graph per worker, so this
 * file gets a fresh picocolors load. We set `NO_COLOR=1` in `beforeAll`
 * BEFORE any import of `./color.ts`, then dynamically import it inside the
 * tests so v8 coverage instruments the identity branch.
 *
 * The first import of `./color.ts` MUST happen after `NO_COLOR=1` is set,
 * so this file does NOT static-import `./color.ts` at the top.
 */

let originalNoColor: string | undefined;

beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});

afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe('color helpers identity branch under NO_COLOR=1 (in-process)', () => {
  it('all seven helpers return their input UNCHANGED (===) when picocolors disables color', async () => {
    // Dynamic import lands in v8's instrumented module graph; the identity
    // branch (line 23-41 `: s`) gets covered.
    const { red, yellow, green, cyan, blue, dim, bold } = await import('./color.ts');
    // toBe (===) is the strict-identity assertion the plan calls for. If
    // picocolors evaluated `isColorSupported = true` for any reason, these
    // would return ANSI-wrapped strings (e.g. '\x1b[31mX\x1b[39m') and fail.
    expect(red('X')).toBe('X');
    expect(yellow('X')).toBe('X');
    expect(green('X')).toBe('X');
    expect(cyan('X')).toBe('X');
    expect(blue('X')).toBe('X');
    expect(dim('X')).toBe('X');
    expect(bold('X')).toBe('X');
  });

  it('identity holds for empty strings (no wrapping artifacts)', async () => {
    const { red, yellow, green, cyan, blue, dim, bold } = await import('./color.ts');
    for (const fn of [red, yellow, green, cyan, blue, dim, bold]) {
      expect(fn('')).toBe('');
    }
  });

  it('identity holds for multi-line strings', async () => {
    const { red } = await import('./color.ts');
    const multi = 'line one\nline two\nline three';
    expect(red(multi)).toBe(multi);
  });
});
