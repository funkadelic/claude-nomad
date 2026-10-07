import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every source file that runs `git pull --autostash`, mapped to the file that
 * calls `assertNoAutostashConflict` and the pull call that guard must follow. A
 * pull with `--autostash` exits 0 on a conflicted stash pop, so an unguarded
 * site would commit conflict markers as config.
 */
const GUARDED_SITES: Record<string, { guard: string; pull: string }> = {
  'commands/pull/collision.ts': {
    guard: 'commands/pull/pull.ts',
    pull: 'pullWithCollisionRunbook(repo',
  },
  'commands/push/checks.ts': { guard: 'commands/push/checks.ts', pull: "'--autostash'" },
};

/** The flag as any JS string literal: single, double or backtick quoted. */
const AUTOSTASH_LITERAL = /(['"`])--autostash\1/;

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
      AUTOSTASH_LITERAL.test(readFileSync(join(SRC, p), 'utf8')),
    );
    expect(sites).toEqual(Object.keys(GUARDED_SITES).sort());
  });

  it.each(Object.entries(GUARDED_SITES))(
    '%s is guarded after the pull',
    (_site, { guard, pull }) => {
      const src = readFileSync(join(SRC, guard), 'utf8');
      const pullAt = src.indexOf(pull);
      expect(pullAt, `${pull} not found in ${guard}`).toBeGreaterThan(-1);
      expect(src.indexOf('assertNoAutostashConflict(', pullAt)).toBeGreaterThan(pullAt);
    },
  );
});
