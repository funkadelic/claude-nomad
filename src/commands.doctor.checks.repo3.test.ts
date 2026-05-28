import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { restoreEnv } from './commands.doctor.checks.test-helpers.ts';

describe('reportSharedLinks dangling symlink detection', () => {
  // lstatSync does NOT follow symlinks, so a symlink whose target was deleted
  // still reports isSymbolicLink() === true and (before the fix) rendered a
  // green OK row, masking the broken link. reportSharedLinks now resolves the
  // target with statSync: a missing target warns "broken symlink (target
  // missing)", a non-ENOENT failure warns "target unreadable", and a resolving
  // target stays green. The dangling and healthy cases use real symlinks on
  // disk; the unreadable case mocks statSync (a real EACCES target is not
  // portably reproducible in CI).

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    originalNomadRepo = process.env.NOMAD_REPO;
    // NO_COLOR=1 keeps the glyph assertions free of ANSI escape noise.
    process.env.NO_COLOR = '1';
    process.exitCode = 0;

    testHome = mkdtempSync(join(tmpdir(), 'nomad-dangling-test-'));
    process.env.HOME = testHome;
    // Point NOMAD_REPO away from the developer's real repo so config.ts does
    // not read live state when it re-loads under the sandbox HOME.
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    mkdirSync(join(testHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.resetModules();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('warns "broken symlink" for a SHARED_LINKS entry whose target is gone but the repo still has the source', async () => {
    // resetModules first so config.ts recomputes CLAUDE_HOME from the sandbox
    // HOME set in beforeEach rather than serving a cached real-HOME instance.
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    // Repo still has the shared source, so the dangling link is a real problem.
    mkdirSync(join(testHome, 'claude-nomad', 'shared', name), { recursive: true });
    // Dangling: the link itself exists, but its target does not.
    symlinkSync(join(testHome, 'no-such-target'), join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(warnGlyph);
    expect(row).toContain('broken symlink');
    expect(row).toContain('nomad pull');
    // A broken link is a non-blocking warn (mirrors the original "missing"
    // row), so unlike a NOT-a-symlink regular file it must NOT set exitCode.
    expect(process.exitCode).toBe(0);
  });

  it('notes a stale symlink (info, not warn) when the dangling link has no repo source', async () => {
    // Dangling link with NO shared/<name> source in the repo: the source was
    // removed, so the leftover link is expected cruft, reported as a calm info
    // note ("safe to remove") rather than a warning.
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    symlinkSync(join(testHome, 'no-such-target'), join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(infoGlyph);
    expect(row).toContain('stale symlink');
    expect(row).toContain('safe to remove');
    expect(row).not.toContain(warnGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('keeps the green OK row when the symlink target resolves', async () => {
    // Guards against over-correction: a symlink pointing at an existing target
    // (statSync resolves it) must still render the green OK row.
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    const target = join(testHome, 'real-target');
    writeFileSync(target, 'shared content');
    symlinkSync(target, join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).toContain('symlink');
    expect(row).not.toContain('broken');
    expect(process.exitCode).toBe(0);
  });

  it('warns "target unreadable" (not "missing") when the target fails with a non-ENOENT error', async () => {
    // A real symlink (so the real lstatSync reports isSymbolicLink() === true)
    // whose target statSync rejects with EACCES. The entry must be flagged as
    // unreadable with the error code, not misclassified as a missing target.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        statSync: vi.fn((p: fsModule.PathLike, opts?: unknown) => {
          if (typeof p === 'string' && p.includes('.claude')) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          // @ts-expect-error -- pass-through with optional opts param
          return actual.statSync(p, opts);
        }),
      };
    });
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    const target = join(testHome, 'unreadable-target');
    writeFileSync(target, 'x');
    symlinkSync(target, join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(warnGlyph);
    expect(row).toContain('unreadable');
    expect(row).toContain('EACCES');
    expect(row).not.toContain('target missing');
    expect(process.exitCode).toBe(0);
  });
});
