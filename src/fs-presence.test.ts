import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsPresenceModule from './fs-presence.ts';
import { classifyPresence, isUnusableTarget, lexists, type PresenceState } from './fs-presence.ts';

/**
 * Register a `node:fs` mock whose `lstatSync` throws `code` for `blocked` and
 * delegates to the real implementation for every other path, then load a fresh
 * copy of the module under test against it.
 *
 * A real `EACCES` is not portably reproducible in CI, the same reasoning
 * `commands.doctor.checks.repo3.test.ts`'s own unreadable-target case
 * documents for its `statSync` mock. Only `lstatSync` is mocked, since
 * `classifyPresence`'s own throw path is `lstatSync`'s, not `statSync`'s.
 *
 * The caller is responsible for nothing: the `doUnmock` is in `afterEach`,
 * because `vi.restoreAllMocks` does not clear a `doMock` registration and an
 * assertion that throws before an inline `doUnmock` would leak the mock into
 * every later test file.
 *
 * @param blocked - The one absolute path whose `lstatSync` throws.
 * @param code - The errno to throw for it.
 * @returns The freshly imported module under test.
 */
async function withThrowingLstat(blocked: string, code: string): Promise<typeof fsPresenceModule> {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      lstatSync: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
        if (String(p) === blocked) {
          const err = new Error(`stat failed: ${code}`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        return actual.lstatSync(p, opts);
      },
    };
  });
  vi.resetModules();
  return import('./fs-presence.ts');
}

describe('classifyPresence', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nomad-fs-presence-'));
  });

  afterEach(() => {
    // Pair every doMock with a doUnmock here rather than inline after the
    // assertions: restoreAllMocks does NOT clear a doMock registration, so a
    // failing assertion would otherwise leak the fs mock into later files.
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns absent for a path with nothing at it', () => {
    expect(classifyPresence(join(tempRoot, 'nothing-here'))).toBe('absent');
  });

  it('returns resolves for a real directory', () => {
    const dir = join(tempRoot, 'a-dir');
    mkdirSync(dir);
    expect(classifyPresence(dir)).toBe('resolves');
  });

  it('returns resolves for a real file', () => {
    const file = join(tempRoot, 'a-file.txt');
    writeFileSync(file, 'content');
    expect(classifyPresence(file)).toBe('resolves');
  });

  it('returns dangling for a symlink whose target does not exist', () => {
    const link = join(tempRoot, 'a-dangling-link');
    symlinkSync(join(tempRoot, 'no-such-target'), link);
    expect(classifyPresence(link)).toBe('dangling');
  });

  it('returns unknown, not absent, when lstatSync throws a genuine error', async () => {
    const blocked = join(tempRoot, 'unreadable-parent-entry');
    const { classifyPresence: mockedClassifyPresence, lexists: mockedLexists } =
      await withThrowingLstat(blocked, 'EACCES');

    expect(mockedClassifyPresence(blocked)).toBe('unknown');
    // The fail-safe direction: an unreadable entry reports present, the
    // opposite of the `lexists` copies that fold every thrown error to false.
    expect(mockedLexists(blocked)).toBe(true);
  });

  it('returns absent when the throw means nothing can be at the path', async () => {
    // ENOTDIR: a component of the path is a regular file, so `shared/` is not
    // a directory. Reporting present-but-unknown here would send the user
    // after an entry that does not exist, and would refuse adopt with an
    // instruction they cannot follow.
    const blocked = join(tempRoot, 'a-file-that-is-not-a-dir', 'child');
    const { classifyPresence: mockedClassifyPresence, lexists: mockedLexists } =
      await withThrowingLstat(blocked, 'ENOTDIR');

    expect(mockedClassifyPresence(blocked)).toBe('absent');
    expect(mockedLexists(blocked)).toBe(false);
  });
});

describe('lexists', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nomad-fs-presence-lexists-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('is false only for absent, and true for resolves and dangling', () => {
    const absentPath = join(tempRoot, 'nothing-here');
    expect(lexists(absentPath)).toBe(false);

    const dir = join(tempRoot, 'a-dir');
    mkdirSync(dir);
    expect(lexists(dir)).toBe(true);

    const link = join(tempRoot, 'a-dangling-link');
    symlinkSync(join(tempRoot, 'no-such-target'), link);
    expect(lexists(link)).toBe(true);
  });
});

describe('isUnusableTarget', () => {
  it('is true for dangling and unknown, and false for absent and resolves', () => {
    const table: [PresenceState, boolean][] = [
      ['absent', false],
      ['resolves', false],
      ['dangling', true],
      ['unknown', true],
    ];
    for (const [state, expected] of table) {
      expect(isUnusableTarget(state)).toBe(expected);
    }
  });
});
