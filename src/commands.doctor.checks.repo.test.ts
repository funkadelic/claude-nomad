import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as diffModule from './extras-sync.diff.ts';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';
import { stubPlatform } from './test-helpers.platform.ts';

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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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

  const isWin = process.platform === 'win32';

  it.skipIf(isWin)(
    'reports FAIL and sets exitCode=1 when a SHARED_LINKS entry exists as a regular file in ~/.claude/',
    async () => {
      // Place a regular file (not a symlink) at ~/.claude/CLAUDE.md. The
      // SHARED_LINKS loop's lstatSync().isSymbolicLink() branch must surface
      // the blocks-sync diagnostic as an explicit FAIL and mark the run failed
      // so scripts and CI catch the regression.
      writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# regular file\n');
      const { cmdDoctor } = await import('./commands.doctor.ts');
      cmdDoctor({ verbose: true });
      const out = joinedLog(env.logSpy);
      expect(out).toContain(
        `${failGlyph} CLAUDE.md: NOT a symlink (blocks sync); run \`nomad adopt CLAUDE.md\` to fix`,
      );
      expect(process.exitCode).toBe(1);
    },
  );
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
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('gsd: symlink');
    expect(process.exitCode).toBe(0);
  });

  it('degrades to { projects: {} } when path-map.json is missing (static rows still emit)', async () => {
    // No path-map.json written. cmdDoctor's tolerant read must fall back to an
    // empty map so the static SHARED_LINKS rows still render instead of throwing.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    // CLAUDE.md is in SHARED_LINKS; it should appear as an info/warn/ok row.
    // We only assert that no throw occurred and that output contains link-related rows.
    expect(out).toContain('CLAUDE.md');
    expect(process.exitCode).not.toBeUndefined();
  });
});

describe('reportSharedLinks non-symlink fail path (direct)', () => {
  // Tests that exercise classifySharedLink's non-symlink branch via
  // reportSharedLinks directly, without going through the full cmdDoctor stack.
  // This isolates the L131 BooleanLiteral mutation: `fail: true` -> `fail: false`
  // in classifySharedLink would allow a non-symlink file to avoid setting
  // exitCode=1.

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-repo-direct-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  // On win32, classifySharedLink's copy-sync branch reports a regular file as
  // OK by design; the posix FAIL expectation is false there. The win32-OK
  // behavior is covered by commands.doctor.checks.repo2.test.ts.
  const isWin = process.platform === 'win32';

  it('does not write a rejected sharedDirs entry to stderr while gathering', async () => {
    // The rejection belongs in-tree, where the Summary repeats it and the
    // verdict counts it. A stderr line here is a third, uncounted glyph and it
    // lands while the spinner owns the terminal. Asserts the `{ quiet: true }`
    // argument at this call site: dropping it makes this fail.
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    reportSharedLinks(section('Links'), { projects: {}, sharedDirs: ['.env'] });

    expect(errSpy).not.toHaveBeenCalled();
  });

  it.skipIf(isWin)(
    'sets exitCode=1 and emits a FAIL row when a SHARED_LINKS entry is a regular file',
    async () => {
      // Kills the L131 BooleanLiteral mutation: `fail: true` -> `fail: false` in
      // classifySharedLink's non-symlink branch would let reportSharedLinks skip
      // the `process.exitCode = 1` assignment, silently masking the "blocks sync"
      // condition. Going directly to reportSharedLinks (not cmdDoctor) ensures the
      // assertion is clean, without exitCode noise from other doctor sections.
      const { SHARED_LINKS } = await import('./config.ts');
      const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
      const { section } = await import('./commands.doctor.format.ts');
      const name = SHARED_LINKS[0];
      if (!name) throw new Error('SHARED_LINKS is empty');
      // Write a regular file (NOT a symlink) at ~/.claude/<name>.
      writeFileSync(join(testHome, '.claude', name), '# placeholder\n');

      const sec = section('Links');
      reportSharedLinks(sec, { projects: {} });

      const failRows = sec.items.filter((r) => r.includes(failGlyph));
      expect(failRows.length).toBeGreaterThan(0);
      expect(failRows.some((r) => r.includes(name))).toBe(true);
      expect(failRows.some((r) => r.includes('NOT a symlink'))).toBe(true);
      expect(process.exitCode).toBe(1);
    },
  );
});

describe('reportHostAndPaths NOMAD_REPO info line (direct)', () => {
  // Tests for the NOMAD_REPO info line emitted by reportHostAndPaths.
  // These kill the L58 ConditionalExpression survivors (always/never emit the
  // line) and the L59 StringLiteral format mutation.

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-hostandpaths-'));
    process.env.HOME = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits a NOMAD_REPO info line when NOMAD_REPO is set', async () => {
    // Kills L58 ConditionalExpression -> false: the NOMAD_REPO line is
    // conditionally shown only when the env override is active. A mutation that
    // always suppresses it would make the annotation invisible.
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostAndPaths } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Host');
    reportHostAndPaths(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain('NOMAD_REPO:');
    expect(rows).toContain(join(testHome, 'claude-nomad'));
  });

  it('does NOT emit a NOMAD_REPO info line when NOMAD_REPO is unset', async () => {
    // Kills L58 ConditionalExpression -> true: a mutation that always emits the
    // line would add a spurious NOMAD_REPO annotation on every doctor run,
    // even when the user is on the default repo path.
    delete process.env.NOMAD_REPO;
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostAndPaths } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Host');
    reportHostAndPaths(sec);
    const rows = sec.items.join('\n');
    expect(rows).not.toContain('NOMAD_REPO:');
  });

  it('emits NOMAD_HOST info line (kills L51 BlockStatement and L57 StringLiteral)', async () => {
    // If the entire reportHostAndPaths body is replaced with {} (L51 mutation),
    // no items are added. Asserting at least the NOMAD_HOST line is present
    // kills the BlockStatement mutation.
    process.env.NOMAD_HOST = 'test-host';
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostAndPaths } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Host');
    reportHostAndPaths(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain('NOMAD_HOST:');
    expect(rows).toContain('test-host');
    // repo line must also be present (kills L61 StringLiteral mutation).
    expect(rows).toContain('repo:');
    // claude home line must also be present (kills L64 StringLiteral mutation).
    expect(rows).toContain('claude home:');
  });
});

describe('reportDroppedNamesMigration migration probe (direct)', () => {
  // Tests that exercise reportDroppedNamesMigration directly for the
  // dropped-names migration probe: hooks and agents were removed from
  // SHARED_LINKS; leftover symlinks at ~/.claude/hooks or ~/.claude/agents
  // should emit a WARN-level migration hint. The probe must NEVER set
  // process.exitCode (it is informational guidance, not a FAIL).

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-dropped-names-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits a WARN line for a leftover hooks symlink without setting exitCode (B5)', async () => {
    // A leftover ~/.claude/hooks symlink from the old era must produce a
    // migration hint. exitCode must stay 0 (guidance, not a FAIL).
    const target = join(testHome, 'some-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(testHome, '.claude', 'hooks'));

    const { section } = await import('./commands.doctor.format.ts');
    const { reportDroppedNamesMigration } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportDroppedNamesMigration(sec);

    const rows = sec.items.join('\n');
    expect(rows).toContain('hooks');
    expect(rows).toContain('gsd now owns this dir per-host');
    expect(rows).toContain('rm ~/.claude/hooks');
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN line for a leftover agents symlink without setting exitCode (B6)', async () => {
    // Same as B5 but for agents.
    const target = join(testHome, 'some-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(testHome, '.claude', 'agents'));

    const { section } = await import('./commands.doctor.format.ts');
    const { reportDroppedNamesMigration } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportDroppedNamesMigration(sec);

    const rows = sec.items.join('\n');
    expect(rows).toContain('agents');
    expect(rows).toContain('gsd now owns this dir per-host');
    expect(rows).toContain('rm ~/.claude/agents');
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing and leaves exitCode unchanged when no leftover symlinks exist (clean host)', async () => {
    // A host that already migrated (no hooks/agents paths at all) must produce
    // zero output rows from the probe.
    const { section } = await import('./commands.doctor.format.ts');
    const { reportDroppedNamesMigration } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportDroppedNamesMigration(sec);

    expect(sec.items).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing when hooks/agents exist as real directories (gsd already owns them)', async () => {
    // If gsd has already created a real directory at ~/.claude/hooks, the probe
    // must skip it (migration already done). Only symlinks trigger the hint.
    mkdirSync(join(testHome, '.claude', 'hooks'), { recursive: true });
    mkdirSync(join(testHome, '.claude', 'agents'), { recursive: true });

    const { section } = await import('./commands.doctor.format.ts');
    const { reportDroppedNamesMigration } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportDroppedNamesMigration(sec);

    expect(sec.items).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });
});

describe('reportRepoState NOMAD_REPO annotation (direct)', () => {
  // Kills L76 StringLiteral mutation: `' (NOMAD_REPO)'` -> `''` (empty string).
  // If the annotation string is empty the test asserting its presence would
  // fail, killing the mutation.

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-repostate-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('appends (NOMAD_REPO) annotation on the repo-state line when NOMAD_REPO is set', async () => {
    // Direct test on reportRepoState so the assertion is unambiguous.
    // Kills L76 StringLiteral -> '' mutation.
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportRepoState } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Repo');
    reportRepoState(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain('repo state:');
    expect(rows).toContain(' (NOMAD_REPO)');
  });

  it('omits (NOMAD_REPO) annotation when NOMAD_REPO is unset', async () => {
    // Kills L58 ConditionalExpression -> true in reportHostAndPaths (secondary);
    // also pins the overrideLabel = '' path in reportRepoState.
    delete process.env.NOMAD_REPO;
    vi.resetModules();
    const { section } = await import('./commands.doctor.format.ts');
    const { reportRepoState } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Repo');
    reportRepoState(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain('repo state:');
    expect(rows).not.toContain('(NOMAD_REPO)');
  });
});

describe('classifySharedLink win32 content-drift compare (direct)', () => {
  // Regression tests for the doctor content-compare added to the win32
  // real-copy branch: a drifted copy WARNs with its diverging files listed,
  // a clean one still reads OK, the WARN never touches process.exitCode, and
  // the compare itself never throws.
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-win32-drift-'));
    process.env.HOME = testHome;
    // home()'s win32 branch reads USERPROFILE before HOME; a stale value from
    // an earlier describe in this shared worker must not leak in here.
    process.env.USERPROFILE = testHome;
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    claudeDir = join(testHome, '.claude');
    sharedDir = join(testHome, 'claude-nomad', 'shared');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./extras-sync.diff.ts');
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('WARNs naming the diverging file count when a win32 real copy differs from shared/<name>', async () => {
    stubPlatform('win32');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const name = SHARED_LINKS[0];
    writeFileSync(join(sharedDir, name), '# shared content\n');
    writeFileSync(join(claudeDir, name), '# drifted local content\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(name) && !item.startsWith('\t'));
    expect(row).toBeDefined();
    expect(row).toContain(warnGlyph);
    expect(row).toContain('diverge from shared/');
    expect(process.exitCode).toBe(0);
    // The diverging file itself renders as a child row (leading-tab marker,
    // see addChildItem) beneath the summary line.
    const childRow = sec.items.find((item) => item.startsWith('\t'));
    expect(childRow).toBeDefined();
    expect(childRow).toContain(name);
  });

  it('still reads OK when a win32 real copy matches shared/<name> byte-for-byte', async () => {
    stubPlatform('win32');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const name = SHARED_LINKS[0];
    writeFileSync(join(sharedDir, name), '# identical content\n');
    writeFileSync(join(claudeDir, name), '# identical content\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(name));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).toContain('win32 copy-sync');
    expect(process.exitCode).toBe(0);
  });

  it('leaves process.exitCode untouched by the drift WARN and still renders a later row', async () => {
    stubPlatform('win32');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const drifted = SHARED_LINKS[0];
    const clean = SHARED_LINKS[1];
    if (drifted === undefined || clean === undefined) {
      throw new Error('SHARED_LINKS needs at least two entries for this test');
    }
    writeFileSync(join(sharedDir, drifted), '# shared\n');
    writeFileSync(join(claudeDir, drifted), '# drifted\n');
    writeFileSync(join(sharedDir, clean), '# same\n');
    writeFileSync(join(claudeDir, clean), '# same\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    expect(process.exitCode).toBe(0);
    const driftedRow = sec.items.find((item) => item.includes(drifted) && !item.startsWith('\t'));
    const cleanRow = sec.items.find((item) => item.includes(clean));
    expect(driftedRow).toContain(warnGlyph);
    expect(cleanRow).toContain(okGlyph);
  });

  it('skips the compare (stays the plain OK row) when the repo has no shared/<name> source', async () => {
    stubPlatform('win32');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const name = SHARED_LINKS[0];
    // No shared/<name> written at all: nothing to compare against.
    writeFileSync(join(claudeDir, name), '# local only\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(name));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).toContain('win32 copy-sync');
  });

  it('never throws when the compare cannot run (git absent from PATH)', async () => {
    stubPlatform('win32');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const name = SHARED_LINKS[0];
    writeFileSync(join(sharedDir, name), '# shared\n');
    writeFileSync(join(claudeDir, name), '# local\n');

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    expect(() => reportSharedLinks(sec, { projects: {} })).not.toThrow();
    expect(process.exitCode).toBe(0);
    const warned = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warned).toContain('git not on PATH');
  });

  it('does not count a never-synced deny-set file under a shared name as drift', async () => {
    stubPlatform('win32');
    vi.resetModules();
    // Both sync directions filter this basename out, so it exists locally by
    // design and can never reach the repo. Reporting it as drift would produce
    // a WARN on every run that no command could clear.
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{}\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).not.toContain('diverge from shared/');
    expect(process.exitCode).toBe(0);
  });

  it('does not count a local-only directory segment on the never-sync list as drift', async () => {
    stubPlatform('win32');
    vi.resetModules();
    // The never-sync list holds ordinary-sounding DIRECTORY names, and the
    // mirror refuses to copy such a segment into the repo, so it can only ever
    // exist on the local side. A basename test cannot see it (the file itself
    // is an unremarkable notes.md), which would leave the host with a WARN on
    // every run that no command could clear.
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# notes\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).not.toContain('diverge from shared/');
    // The exemption is permanent (the mirror will never copy it and the pull is
    // silent about it), so the row that stays OK is the only place the user
    // could learn the divergence exists at all.
    expect(row).toContain('1 never-synced path(s) not compared');
    expect(process.exitCode).toBe(0);
  });

  it('does not count a repo-only directory segment on the never-sync list as drift', async () => {
    stubPlatform('win32');
    vi.resetModules();
    // The repo-only side of the same exemption: git reports this path under
    // the REPO root, so relativizing it against the local root would escape
    // the tree and the segment scan would miss the denied name.
    mkdirSync(join(sharedDir, 'commands', 'tasks'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(sharedDir, 'commands', 'tasks', 'plan.md'), '# plan\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toBeDefined();
    expect(row).toContain(okGlyph);
    expect(row).not.toContain('diverge from shared/');
    expect(process.exitCode).toBe(0);
  });

  it('says nothing about exempted paths when the compare threw none out', async () => {
    stubPlatform('win32');
    vi.resetModules();
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'a.md'), '# same\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toContain(okGlyph);
    expect(row).not.toContain('not compared');
  });

  it('does not exempt a diverging path it cannot place under either compare root', async () => {
    stubPlatform('win32');
    vi.resetModules();
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'a.md'), '# same\n');
    writeFileSync(join(claudeDir, 'commands', 'a.md'), '# same\n');
    // A win32 host whose sync repo sits on a different drive from the compare
    // root: relative() across drive letters returns the destination verbatim
    // and absolute rather than a `..` walk, so a path that is under neither
    // root can carry the repo's own location into the segment scan. Every
    // segment of `D:\sessions\...` would then be tested, exempting every
    // repo-only file on that host. Unplaceable means not exempt.
    vi.doMock('./extras-sync.diff.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof diffModule>()),
      listDivergingFiles: () => ['D:\\sessions\\claude-nomad\\shared\\commands\\b.md (repo only)'],
    }));

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toContain(warnGlyph);
    expect(row).toContain('diverge from shared/');
    expect(row).not.toContain('not compared');
    expect(process.exitCode).toBe(0);
  });

  it('still counts an ordinary nested file as drift, so the exemption is not a blanket one', async () => {
    stubPlatform('win32');
    vi.resetModules();
    mkdirSync(join(sharedDir, 'commands', 'deploy'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands', 'deploy'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'deploy', 'go.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'commands', 'deploy', 'go.md'), '# drifted\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes('commands') && !item.startsWith('\t'));
    expect(row).toBeDefined();
    expect(row).toContain(warnGlyph);
    expect(row).toContain('diverge from shared/');
    expect(process.exitCode).toBe(0);
  });

  it('still FAILs a non-symlink on posix, unaffected by the win32 drift compare', async () => {
    stubPlatform('linux');
    vi.resetModules();
    const { SHARED_LINKS } = await import('./config.ts');
    const name = SHARED_LINKS[0];
    writeFileSync(join(sharedDir, name), '# shared\n');
    writeFileSync(join(claudeDir, name), '# local, but not a symlink\n');

    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    const row = sec.items.find((item) => item.includes(name));
    expect(row).toBeDefined();
    expect(row).toContain(failGlyph);
    expect(row).toContain('NOT a symlink');
    expect(process.exitCode).toBe(1);
  });
});
