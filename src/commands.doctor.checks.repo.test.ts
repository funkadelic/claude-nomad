import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

describe('cmdDoctor repo-state header', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    // NO_COLOR=1 so substring asserts on `PASS`/`WARN`/`FAIL` aren't split
    // by ANSI escapes (matches the convention in every other doctor describe
    // block in this file).
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host', writeBase: false });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits FAIL empty with init-hint and sets exitCode=1 when scaffold is absent', async () => {
    // Fresh sandbox: makeDoctorEnv with writeBase:false leaves no
    // settings.base.json. The empty branch should fire.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} repo state: empty`);
    expect(out).toContain("run 'nomad init' to scaffold");
    expect(process.exitCode).toBe(1);
  });

  it('emits WARN partial with path-map.json missing suffix when only base is present', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // base present, path-map.json missing -> partial with the second priority
    // suffix (settings.base.json missing is suffix #1; path-map.json missing
    // is suffix #2 and fires next).
    expect(out).toContain(`${warnGlyph} repo state: partial - path-map.json missing`);
  });

  it('emits WARN partial with hosts/<HOST>.json missing suffix when base + path-map populated', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // base + populated path-map.projects, host file missing -> partial with
    // the hosts/<HOST>.json suffix (priority order #4).
    expect(out).toContain(`${warnGlyph} repo state: partial - hosts/test-host.json missing`);
  });

  it('emits WARN partial with empty-projects suffix when path-map.json exists but has zero entries', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      `${warnGlyph} repo state: partial - path-map.json.projects has no entries`,
    );
  });

  it('emits PASS populated when settings.base.json + populated path-map + hosts/<host>.json all present', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} repo state: populated`);
  });

  it('logs the repo state line above the SHARED_LINKS / symlink section', async () => {
    // Place a regular file (NOT a symlink) at ~/.claude/CLAUDE.md so the
    // SHARED_LINKS loop emits a 'symlink' substring (the "NOT a symlink" or
    // "symlink OK" branch). The repo-state line is fixed to land before the
    // SHARED_LINKS loop, so its index must precede the first 'symlink' hit.
    writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# placeholder\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    const repoIdx = out.indexOf('repo state:');
    const symlinkIdx = out.indexOf('symlink');
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(symlinkIdx).toBeGreaterThan(repoIdx);
  });
});

describe('cmdDoctor SHARED_LINKS symlink integrity', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('reports FAIL and sets exitCode=1 when a SHARED_LINKS entry exists as a regular file in ~/.claude/', async () => {
    // Place a regular file (not a symlink) at ~/.claude/CLAUDE.md. The
    // SHARED_LINKS loop's lstatSync().isSymbolicLink() branch must surface
    // the blocks-sync diagnostic as an explicit FAIL and mark the run failed
    // so scripts and CI catch the regression.
    writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# regular file\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} CLAUDE.md: NOT a symlink (blocks sync)`);
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor sharedDirs symlink row', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits a status line for a sharedDirs entry when path-map.json declares it', async () => {
    // Write path-map.json with sharedDirs: ['gsd'] and a correct symlink at
    // ~/.claude/gsd -> shared/gsd. The doctor should emit an okGlyph row for gsd.
    const repoHome = join(env.testHome, 'claude-nomad');
    const sharedDir = join(repoHome, 'shared');
    mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
    writeFileSync(join(sharedDir, 'gsd', 'tool.sh'), '#!/bin/sh\n');
    writeFileSync(
      join(repoHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['gsd'] }) + '\n',
    );
    const linkPath = join(env.testHome, '.claude', 'gsd');
    symlinkSync(join(sharedDir, 'gsd'), linkPath);

    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('gsd: symlink');
    expect(process.exitCode).toBe(0);
  });

  it('degrades to { projects: {} } when path-map.json is missing (hooks + static rows still emit)', async () => {
    // No path-map.json written. cmdDoctor's tolerant read must fall back to an
    // empty map so the static SHARED_LINKS rows (including hooks) still render
    // instead of throwing.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // hooks is in SHARED_LINKS; it should appear as an info/warn/ok row.
    // We only assert that no throw occurred and that output contains link-related rows.
    expect(out).toContain('hooks');
    expect(process.exitCode).not.toBeUndefined();
  });
});
