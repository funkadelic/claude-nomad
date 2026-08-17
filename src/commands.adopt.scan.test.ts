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
    // The pruning fixture has to be a directory, and the narrow exact-name
    // set (ALWAYS_NEVER_SYNC) holds only file names, so the credential-shape
    // axis is the only source of a denied directory fixture, which is why
    // this asserts a null matched entry rather than a list entry. The nested
    // `todos/` proves the prune stops before an ORDINARY name, and the
    // nested `history.jsonl` (a real name-axis hit) proves it stops before a
    // REAL one too, not merely before nothing.
    root = makeRoot();
    const credentialsDir = join(root, 'credentials');
    mkdirSync(join(credentialsDir, 'todos'), { recursive: true });
    writeFileSync(join(credentialsDir, 'history.jsonl'), 'inner\n');

    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'credentials', matched: null });
    expect(hits.some((hit) => hit.path.startsWith('credentials/'))).toBe(false);
  });

  it('reports a denied file matched by exact name, carrying the entry it matched', () => {
    root = makeRoot();
    writeFileSync(join(root, 'settings.local.json'), '{}\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'settings.local.json', matched: 'settings.local.json' });
  });

  it('reports a denied file matched by credential shape with a null matched entry', () => {
    // The null is what tells the refusal to withhold the rename remedy: the
    // extension is what matched, so a rename would land in the same refusal.
    root = makeRoot();
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: '.env', matched: null });
  });

  it('reports a nested hit with a forward-slashed path relative to the root', () => {
    root = makeRoot();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'history.jsonl'), '{}\n');
    const hits = scanDeniedEntries(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'a/b/history.jsonl', matched: 'history.jsonl' });
  });

  it('returns entries sorted by path regardless of filesystem listing order', () => {
    root = makeRoot();
    // Created in fully reverse alphabetical order, so a two-way comparator
    // walking these three pairs is exercised in both directions regardless
    // of which order readdirSync happens to list them in. All three are
    // exact-name-axis survivors under ALWAYS_NEVER_SYNC.
    writeFileSync(join(root, 'stats-cache.json'), '{}\n');
    writeFileSync(join(root, 'settings.local.json'), '{}\n');
    writeFileSync(join(root, 'history.jsonl'), '{}\n');
    const hits = scanDeniedEntries(root);
    expect(hits.map((hit) => hit.path)).toEqual([
      'history.jsonl',
      'settings.local.json',
      'stats-cache.json',
    ]);
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

  it('returns [] for a tree whose only denied-looking names are ordinary runtime-state directories', () => {
    // An ordinary directory name Claude Code happens to use for its own
    // runtime state under ~/.claude/ is nested user content here, under a
    // name the user has already asked to share, and is carried rather than
    // refused.
    root = makeRoot();
    mkdirSync(join(root, 'sessions'), { recursive: true });
    mkdirSync(join(root, 'plans'), { recursive: true });
    mkdirSync(join(root, 'tasks'), { recursive: true });
    mkdirSync(join(root, 'cache'), { recursive: true });
    mkdirSync(join(root, 'todos'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'notes.md'), 'a\n');
    writeFileSync(join(root, 'plans', 'a.md'), 'b\n');
    writeFileSync(join(root, 'tasks', 'x.md'), 'c\n');
    writeFileSync(join(root, 'cache', 'y.bin'), 'd\n');
    writeFileSync(join(root, 'todos', 'z.md'), 'e\n');
    expect(scanDeniedEntries(root)).toEqual([]);
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
    mkdirSync(join(root, 'credentials'));
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

  it('throws a NomadFatal listing every hit and what it matched on a dirty root', async () => {
    root = makeRoot();
    writeFileSync(join(root, 'stats-cache.json'), '{}\n');
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
    expect(fatal.message).toContain('stats-cache.json');
    expect(fatal.message).toContain('a/b/history.jsonl');
    expect(fatal.message).toContain('history.jsonl');
    expect(fatal.message).toContain(root);
    expect(fatal.message).toContain('Nothing was changed.');
    expect(fatal.message).toContain('nomad adopt my-tools');
    // Both hits are list collisions, so the rename remedy applies to both and
    // the credential-shape sentence has nothing to describe.
    expect(fatal.message).toContain('matches the never-sync name "stats-cache.json"');
    expect(fatal.message).toContain('renaming a path listed above as a never-sync name');
    expect(fatal.message).not.toContain('credential filename shape');
  });

  it('withholds the rename remedy when every hit matched a credential shape', async () => {
    // Renaming a `deploy.key` lands in an identical refusal, because the
    // extension is what matched. Offering it would be the misdirection the
    // list-collision wording exists to avoid.
    root = makeRoot();
    writeFileSync(join(root, 'deploy.key'), 'PRIVATE\n');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal.message).toContain('deploy.key (matches a credential filename shape)');
    expect(fatal.message).toContain('Move that path out of');
    expect(fatal.message).toContain('renaming a path listed above as a credential filename shape');
    expect(fatal.message).not.toContain('never-sync name');
    // And nothing quotes the file's own basename back as the entry it matched,
    // which would be a sentence that says nothing.
    expect(fatal.message).not.toContain('never-sync name "deploy.key"');
  });

  it('prints both remedies, each scoped to its own axis, on a mixed set of hits', async () => {
    root = makeRoot();
    writeFileSync(join(root, 'settings.local.json'), '{}\n');
    writeFileSync(join(root, 'server.pem'), 'CERT\n');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal).toBeInstanceOf(NomadFatal);
    expect(fatal.message).toContain(
      'settings.local.json (matches the never-sync name "settings.local.json")',
    );
    expect(fatal.message).toContain('server.pem (matches a credential filename shape)');
    expect(fatal.message).toContain('renaming a path listed above as a never-sync name');
    expect(fatal.message).toContain('renaming a path listed above as a credential filename shape');
  });

  it('quotes the denylist entry rather than the case-folded spelling on disk', async () => {
    // Repeating the user's own spelling back at them ("Settings.local.json
    // matches Settings.local.json") names no entry to rename away from.
    root = makeRoot();
    writeFileSync(join(root, 'Settings.local.json'), '{}\n');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal).toBeInstanceOf(NomadFatal);
    expect(fatal.message).toContain('Settings.local.json (matches the never-sync name');
    expect(fatal.message).toContain('"settings.local.json")');
  });

  it('returns without throwing on a tree holding only ordinary runtime-state directory names', () => {
    root = makeRoot();
    const cleanRoot = root;
    mkdirSync(join(cleanRoot, 'sessions'), { recursive: true });
    mkdirSync(join(cleanRoot, 'plans'), { recursive: true });
    mkdirSync(join(cleanRoot, 'tasks'), { recursive: true });
    mkdirSync(join(cleanRoot, 'cache'), { recursive: true });
    mkdirSync(join(cleanRoot, 'todos'), { recursive: true });
    writeFileSync(join(cleanRoot, 'sessions', 'notes.md'), 'a\n');
    expect(() => refuseDeniedEntries('my-tools', cleanRoot)).not.toThrow();
  });

  it('refuses on the same tree plus a real hit, naming only the real hit', async () => {
    // Asserting the message does NOT name the five ordinary directories is
    // the half that would catch a partial swap where the scan narrowed but a
    // message composer still enumerated the wide set.
    root = makeRoot();
    mkdirSync(join(root, 'sessions'), { recursive: true });
    mkdirSync(join(root, 'plans'), { recursive: true });
    mkdirSync(join(root, 'tasks'), { recursive: true });
    mkdirSync(join(root, 'cache'), { recursive: true });
    mkdirSync(join(root, 'todos'), { recursive: true });
    writeFileSync(join(root, 'settings.local.json'), '{}\n');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      refuseDeniedEntries('my-tools', root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal.message).toContain('settings.local.json');
    expect(fatal.message).not.toContain('sessions');
    expect(fatal.message).not.toContain('plans');
    expect(fatal.message).not.toContain('tasks');
    expect(fatal.message).not.toContain('cache');
    expect(fatal.message).not.toContain('todos');
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
