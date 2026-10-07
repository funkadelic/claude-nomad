import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every source file that runs `git pull --autostash`, mapped to the file that
 * calls `assertNoAutostashConflict` after the pull returns. A pull with
 * `--autostash` exits 0 on a conflicted stash pop, so an unguarded site would
 * commit conflict markers as config.
 */
const GUARDED_SITES: Record<string, string> = {
  'commands/pull/collision.ts': 'commands/pull/pull.ts',
  'commands/push/checks.ts': 'commands/push/checks.ts',
};

/**
 * List the non-test `.ts` files under `src/`, as `/`-separated paths relative to it.
 *
 * @returns The relative paths, sorted.
 */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .map((p) => relative(SRC, join(SRC, p)).split(sep).join('/'))
    .sort();
}

describe('--autostash pull sites', () => {
  it('every site is listed with the file that guards it', () => {
    const sites = sourceFiles().filter((p) =>
      readFileSync(join(SRC, p), 'utf8').includes("'--autostash'"),
    );
    expect(sites).toEqual(Object.keys(GUARDED_SITES).sort());
  });

  it.each(Object.entries(GUARDED_SITES))('%s is guarded in %s', (_site, guard) => {
    expect(readFileSync(join(SRC, guard), 'utf8')).toContain('assertNoAutostashConflict(');
  });
});
