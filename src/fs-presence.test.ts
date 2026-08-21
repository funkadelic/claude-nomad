import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyPresence, isUnusableTarget, lexists, type PresenceState } from './fs-presence.ts';

describe('classifyPresence', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nomad-fs-presence-'));
  });

  afterEach(() => {
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

  // A real EACCES is not portably reproducible in CI, the same reasoning
  // commands.doctor.checks.repo3.test.ts's own unreadable-target case
  // documents for its statSync mock. Only lstatSync is mocked here, since
  // classifyPresence's own throw path is lstatSync's, not statSync's.
  it('returns unknown, not absent, when lstatSync throws a genuine error', async () => {
    const blocked = join(tempRoot, 'unreadable-parent-entry');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
          if (String(p) === blocked) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return actual.lstatSync(p, opts);
        },
      };
    });
    vi.resetModules();
    const { classifyPresence: mockedClassifyPresence, lexists: mockedLexists } =
      await import('./fs-presence.ts');

    expect(mockedClassifyPresence(blocked)).toBe('unknown');
    // The fail-safe direction: an unreadable entry reports present, the
    // opposite of the `lexists` copies that fold every thrown error to false.
    expect(mockedLexists(blocked)).toBe(true);

    vi.doUnmock('node:fs');
    vi.resetModules();
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
