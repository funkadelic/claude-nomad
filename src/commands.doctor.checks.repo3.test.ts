import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import { section } from './commands.doctor.format.ts';
import { restoreEnv } from './commands.doctor.checks.test-helpers.ts';

describe('reportSharedLinks dangling symlink detection', () => {
  // The TOCTOU fix swapped an existsSync pre-check (which FOLLOWS symlinks) for
  // a lstatSync (which does NOT). That left a gap: a symlink whose target was
  // deleted still reports isSymbolicLink() === true, so it rendered a green OK
  // row and masked the broken link. reportSharedLinks now follows the link with
  // existsSync and warns "broken symlink (target missing)" for the dangling
  // case while keeping the healthy case green. These tests use real symlinks on
  // disk (no fs mocking) so they pin observable behavior, not internal calls.

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
    vi.resetModules();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('warns "broken symlink" for a SHARED_LINKS entry whose target is gone', async () => {
    // resetModules first so config.ts recomputes CLAUDE_HOME from the sandbox
    // HOME set in beforeEach rather than serving a cached real-HOME instance.
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    // Dangling: the link itself exists, but its target does not.
    symlinkSync(join(testHome, 'no-such-target'), join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec);

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(warnGlyph);
    expect(row).toContain('broken symlink');
    // A broken link is a non-blocking warn (mirrors the original "missing"
    // row), so unlike a NOT-a-symlink regular file it must NOT set exitCode.
    expect(process.exitCode).toBe(0);
  });

  it('keeps the green OK row when the symlink target resolves', async () => {
    // Guards against over-correction: a symlink pointing at an existing target
    // (existsSync follows and returns true) must still render the green OK row.
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const name = SHARED_LINKS[0];
    if (!name) throw new Error('SHARED_LINKS is empty');
    const target = join(testHome, 'real-target');
    writeFileSync(target, 'shared content');
    symlinkSync(target, join(testHome, '.claude', name));

    const sec = section('Links');
    reportSharedLinks(sec);

    const row = sec.items.find((item) => item.includes(`${name}:`));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).toContain('symlink');
    expect(row).not.toContain('broken');
    expect(process.exitCode).toBe(0);
  });
});
