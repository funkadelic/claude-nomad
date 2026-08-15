import type * as fsModule from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT } from './exit-codes.ts';
import { refuseDeniedEntries, scanDeniedEntries } from './commands.adopt.scan.ts';

// This file must stay free of any child-process-spawning API, so
// vitest.config.ts's self-classifying regex keeps it in the fast parallel
// "unit" project rather than moving it into the bounded serial "subprocess"
// project. Naming those APIs literally in this comment would itself trip
// that same regex, so this note describes the rule instead of the tokens.

const isWin = process.platform === 'win32';

/** Make an isolated temp directory to scan, torn down in `afterEach`. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nomad-adopt-scan-test-'));
}

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('scanDeniedEntries', () => {
  it('returns [] for a path that does not exist', () => {
    root = makeRoot();
    expect(scanDeniedEntries(join(root, 'never-created'))).toEqual([]);
  });

  it('returns [] for a regular file root, without throwing ENOTDIR', () => {
    root = makeRoot();
    const filePath = join(root, 'a-file');
    writeFileSync(filePath, 'content\n');
    expect(() => scanDeniedEntries(filePath)).not.toThrow();
    expect(scanDeniedEntries(filePath)).toEqual([]);
  });

  it('returns [] for a clean tree with nested subdirectories', () => {
    root = makeRoot();
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    writeFileSync(join(root, 'sub', 'b.txt'), 'b\n');
    writeFileSync(join(root, 'sub', 'deep', 'c.txt'), 'c\n');
    expect(scanDeniedEntries(root)).toEqual([]);
  });

  it('reports a denied directory once and prunes everything beneath it', () => {
    root = makeRoot();
    const sessionsDir = join(root, 'sessions');
    mkdirSync(join(sessionsDir, 'todos'), { recursive: true });
    writeFileSync(join(sessionsDir, 'inner.txt'), 'inner\n');

    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'sessions', segment: 'sessions' });
    expect(hits.some((hit) => hit.path.startsWith('sessions/'))).toBe(false);
  });

  it('reports a denied file matched by exact name', () => {
    root = makeRoot();
    writeFileSync(join(root, 'settings.local.json'), '{}\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].segment).toBe('settings.local.json');
  });

  it('reports a denied file matched by credential shape rather than exact name', () => {
    root = makeRoot();
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].segment).toBe('.env');
  });

  it('reports a nested hit with a forward-slashed path relative to the root', () => {
    root = makeRoot();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'history.jsonl'), '{}\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'a/b/history.jsonl', segment: 'history.jsonl' });
  });

  it('returns entries sorted by path regardless of filesystem listing order', () => {
    root = makeRoot();
    // Created in fully reverse alphabetical order, so a two-way comparator
    // walking these three pairs is exercised in both directions regardless
    // of which order readdirSync happens to list them in.
    mkdirSync(join(root, 'tasks'));
    mkdirSync(join(root, 'jobs'));
    mkdirSync(join(root, 'cache'));
    const hits = scanDeniedEntries(root);
    expect(hits.map((hit) => hit.path)).toEqual(['cache', 'jobs', 'tasks']);
  });

  it.skipIf(isWin)('does not descend through a symlink to a directory', () => {
    // Unprivileged symlinkSync fails on native Windows; guarded the same way
    // commands.adopt.test.ts guards its own posix-only symlink assertions.
    root = makeRoot();
    const real = join(root, 'real-target');
    mkdirSync(join(real, 'todos'), { recursive: true });
    symlinkSync(real, join(root, 'linked'), 'dir');

    const hits = scanDeniedEntries(root);
    expect(hits.some((hit) => hit.path.startsWith('linked/'))).toBe(false);
  });
});

describe('refuseDeniedEntries', () => {
  it('returns silently on a clean root', () => {
    root = makeRoot();
    const cleanRoot = root;
    writeFileSync(join(cleanRoot, 'tool.sh'), '#!/bin/sh\n');
    expect(() => refuseDeniedEntries('my-tools', cleanRoot)).not.toThrow();
  });

  it('uses singular wording ("that path") when exactly one entry is denied', async () => {
    root = makeRoot();
    mkdirSync(join(root, 'debug'));
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect((caught as InstanceType<typeof NomadFatal>).message).toContain('Move that path out of');
  });

  it('throws a NomadFatal listing every hit and its segment on a dirty root', async () => {
    root = makeRoot();
    mkdirSync(join(root, 'debug'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'history.jsonl'), '{}\n');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal.code).toBe(EXIT.GENERIC_FAILURE);
    expect(fatal.message).toContain('debug');
    expect(fatal.message).toContain('a/b/history.jsonl');
    expect(fatal.message).toContain('history.jsonl');
    expect(fatal.message).toContain(root);
    expect(fatal.message).toContain('Nothing was changed.');
    expect(fatal.message).toContain('nomad adopt my-tools');
  });

  describe('unreadable directory', () => {
    afterEach(() => {
      vi.doUnmock('node:fs');
    });

    it('converts an unreadable directory into a NomadFatal, never letting the raw error escape', async () => {
      root = makeRoot();
      writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\n');
      const scanRoot = root;

      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof fsModule>();
        return {
          ...actual,
          readdirSync: (...args: Parameters<typeof actual.readdirSync>): never => {
            if (String(args[0]) === scanRoot) {
              throw new Error('EACCES: permission denied');
            }
            return actual.readdirSync(...args) as never;
          },
        };
      });
      vi.resetModules();
      const { refuseDeniedEntries: refuseAfterMock } = await import('./commands.adopt.scan.ts');
      const { NomadFatal } = await import('./utils.ts');

      let caught: unknown;
      try {
        refuseAfterMock('my-tools', scanRoot);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NomadFatal);
      const fatal = caught as InstanceType<typeof NomadFatal>;
      expect(fatal.code).toBe(EXIT.GENERIC_FAILURE);
      expect(fatal.message).toContain(scanRoot);
      expect(fatal.message).toContain('EACCES: permission denied');
      expect(fatal.message).toContain('Nothing was changed.');
      // The catch spans several unrelated causes (an unreadable directory, an
      // entry removed mid-listing, a tree deep enough to exhaust the stack),
      // so it quotes the one it caught instead of naming permissions as the
      // reason and sending the user on a retry that fails the same way.
      expect(fatal.message).toContain('readable and not being written to');
      expect(fatal.message).not.toContain('Check its permissions');
    });
  });

  describe('unreadable directory, non-Error throw', () => {
    afterEach(() => {
      vi.doUnmock('node:fs');
    });

    it('quotes a non-Error thrown value via String() rather than reading .message off it', async () => {
      root = makeRoot();
      writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\n');
      const scanRoot = root;

      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof fsModule>();
        return {
          ...actual,
          readdirSync: (...args: Parameters<typeof actual.readdirSync>): never => {
            if (String(args[0]) === scanRoot) {
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              throw 'a plain string, not an Error';
            }
            return actual.readdirSync(...args) as never;
          },
        };
      });
      vi.resetModules();
      const { refuseDeniedEntries: refuseAfterMock } = await import('./commands.adopt.scan.ts');
      const { NomadFatal } = await import('./utils.ts');

      let caught: unknown;
      try {
        refuseAfterMock('my-tools', scanRoot);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NomadFatal);
      const fatal = caught as InstanceType<typeof NomadFatal>;
      expect(fatal.message).toContain('a plain string, not an Error');
    });
  });
});
