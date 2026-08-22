import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as fsPresenceModule from './fs-presence.ts';
import { classifyPresence, isUnusableTarget, lexists, type PresenceState } from './fs-presence.ts';

/**
 * Register a `node:fs` mock whose `which` probe throws `code` for `blocked`
 * and delegates to the real implementation for every other path, then load a
 * fresh copy of the module under test against it.
 *
 * A real `EACCES` is not portably reproducible in CI, the same reasoning
 * `commands.doctor.checks.repo3.test.ts`'s own unreadable-target case
 * documents for its `statSync` mock. Which probe to block is a parameter
 * because `classifyPresence` has two throw paths that mean different things:
 * `lstatSync` failing says nothing is known about the ENTRY, `statSync`
 * failing says nothing is known about what it POINTS AT, and only the second
 * one can report `dangling`.
 *
 * The caller is responsible for nothing: the `doUnmock` is in `afterEach`,
 * because `vi.restoreAllMocks` does not clear a `doMock` registration and an
 * assertion that throws before an inline `doUnmock` would leak the mock into
 * every later test file.
 *
 * @param which - The `node:fs` probe to make throw.
 * @param blocked - The one absolute path whose probe throws.
 * @param code - The errno to throw for it.
 * @returns The freshly imported module under test.
 */
async function withThrowingProbe(
  which: 'lstatSync' | 'statSync',
  blocked: string,
  code: string,
): Promise<typeof fsPresenceModule> {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      [which]: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
        if (String(p) === blocked) {
          const err = new Error(`stat failed: ${code}`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        return actual[which](p, opts);
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

  it('returns unknown, not dangling, for a symlink whose target cannot be read', async () => {
    // The follow probe used to be `existsSync`, which answers false for every
    // failure alike, so an unreachable target was reported as a broken
    // pointer and every consumer then told the user to remove the entry or
    // restore what it points at. Neither is the problem here: the target may
    // be perfectly intact behind a directory this process cannot traverse.
    const link = join(tempRoot, 'an-unreadable-target-link');
    symlinkSync(join(tempRoot, 'blocked-target'), link);
    const { classifyPresence: mockedClassifyPresence } = await withThrowingProbe(
      'statSync',
      link,
      'EACCES',
    );

    expect(mockedClassifyPresence(link)).toBe('unknown');
  });

  it('returns unknown for a symlink cycle, which is present but unfollowable', () => {
    // ELOOP with no mock at all: the entry demonstrably exists (lstat reads
    // it), it just cannot be followed, which is the state `unknown` names.
    const first = join(tempRoot, 'loop-a');
    const second = join(tempRoot, 'loop-b');
    symlinkSync(second, first);
    symlinkSync(first, second);
    expect(classifyPresence(first)).toBe('unknown');
  });

  it('returns unknown, not absent, when lstatSync throws a genuine error', async () => {
    const blocked = join(tempRoot, 'unreadable-parent-entry');
    const { classifyPresence: mockedClassifyPresence, lexists: mockedLexists } =
      await withThrowingProbe('lstatSync', blocked, 'EACCES');

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
      await withThrowingProbe('lstatSync', blocked, 'ENOTDIR');

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
