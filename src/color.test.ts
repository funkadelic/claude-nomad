import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Picocolors caches its `isColorSupported` flag at module load. Because that
 * top-level static import lives inside `./color.ts` (a static import-chain
 * Vitest cannot re-evaluate cross-test per the docs: "top-level imports
 * cannot be re-evaluated"), in-process `vi.resetModules() + await import()`
 * cannot toggle picocolors' env-derived state between tests in the same file
 * after picocolors has loaded once.
 *
 * To assert real production behavior under specific NO_COLOR / FORCE_COLOR
 * states we spawn a fresh Node process via `execFileSync` whose stdout
 * captures `red('FAIL')` evaluated against the toggled env. Each spawn loads
 * `./color.ts` and picocolors from scratch with the desired env in place, so
 * the `isColorSupported` capture matches the production code path exactly.
 *
 * The first dynamic `await import('./color.ts')` in this file still works
 * under env-toggle because nothing has loaded picocolors yet, so we keep one
 * in-process test as a smoke check of the module's exported surface. The
 * `vi.resetModules()` calls in `beforeEach` / `afterEach` keep the registry
 * clean for that smoke test and document the canonical env-toggle pattern
 * even though picocolors is the dependency that resists it.
 *
 * Mirrors the env-toggle scaffold at src/utils.test.ts:70-113 (the
 * "HOST resolution" block) plus the spawn-on-env-toggle escape hatch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COLOR_TS = join(HERE, 'color.ts');

function spawnRed(input: string, env: NodeJS.ProcessEnv): string {
  const script = `import { red } from ${JSON.stringify(COLOR_TS)}; process.stdout.write(red(${JSON.stringify(input)}));`;
  return execFileSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

describe('color helpers (src/color.ts)', () => {
  let originalNoColor: string | undefined;
  let originalForceColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    originalForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
    vi.resetModules();
  });

  it('wraps with an ANSI escape when FORCE_COLOR=1 is set', () => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    env.FORCE_COLOR = '1';
    const out = spawnRed('FAIL', env);
    expect(out).toContain('\x1b[');
    expect(out).toContain('FAIL');
  });

  it('returns input unchanged (identity) when NO_COLOR=1 is set', () => {
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
    const out = spawnRed('FAIL', env);
    expect(out).toBe('FAIL');
  });

  it('honors NO_COLOR precedence even when FORCE_COLOR=1 is also set', () => {
    const env = { ...process.env };
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '1';
    const out = spawnRed('FAIL', env);
    expect(out).toBe('FAIL');
  });

  it('all seven helpers are identity when NO_COLOR=1 (smoke)', async () => {
    process.env.NO_COLOR = '1';
    vi.resetModules();
    const { red, yellow, green, cyan, blue, dim, bold } = await import('./color.ts');
    // In-process: this test relies on this being the FIRST dynamic import of
    // `./color.ts` AFTER picocolors' module body re-runs under NO_COLOR=1.
    // Vitest's `vi.resetModules()` re-evaluates `./color.ts`; whether
    // picocolors' top-level statics are re-run depends on its CJS loader path.
    // The sub-process tests above are the load-bearing assertions; this one
    // covers the exported-name surface (all seven helpers are functions that
    // accept a string).
    for (const fn of [red, yellow, green, cyan, blue, dim, bold]) {
      expect(typeof fn).toBe('function');
      expect(fn('X')).toContain('X');
    }
  });

  it('exposes the expected seven exports via dynamic import', async () => {
    vi.resetModules();
    const mod = await import('./color.ts');
    const names = ['red', 'yellow', 'green', 'cyan', 'blue', 'dim', 'bold'] as const;
    for (const name of names) {
      expect(typeof mod[name]).toBe('function');
    }
  });

  it('sub-process probe: all seven helpers identity under NO_COLOR=1', () => {
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
    const script = `
      import * as c from ${JSON.stringify(COLOR_TS)};
      const names = ['red','yellow','green','cyan','blue','dim','bold'];
      const out = names.map(n => c[n]('X')).join(',');
      process.stdout.write(out);
    `;
    const got = execFileSync(
      'node',
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    expect(got).toBe('X,X,X,X,X,X,X');
  });
});
