import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type PathMap } from './config.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

// Windows chmod only toggles the read-only attribute; a directory chmod'd to
// 0o000 still allows readdirSync there, so this EACCES-injection assertion
// cannot hold on win32.
const isWin = process.platform === 'win32';

describe('cmdDoctor path-encoding collision detection', () => {
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
    env = makeDoctorEnv({ host: 'test-host', writeSettings: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('stays silent on path-encoding collisions when none exist', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo' },
        bar: { 'test-host': '/srv/bar' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    // The gitleaks-presence diagnostic may set exitCode=1 on dev hosts
    // without gitleaks; this test only asserts the path-encoding diagnostic
    // is silent and that no NEW exitCode-setting condition fires from THIS
    // describe's setup.
    expect(joinedLog(env.logSpy)).not.toContain('path-encoding collision');
  });

  it('lists local project dirs missing from the path-map as nested rows under an unmapped header', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    // One local dir matches foo's encoding for this host; one is unmapped.
    mkdirSync(join(env.testHome, '.claude', 'projects', '-srv-foo'), { recursive: true });
    mkdirSync(join(env.testHome, '.claude', 'projects', '-srv-stray'), { recursive: true });
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Unmapped local projects (not synced): 1');
    expect(out).toContain('└ -srv-stray');
    // The mapped dir does not appear in the unmapped list.
    expect(out).not.toContain('├ -srv-foo');
  });

  it.skipIf(isWin)(
    'skips the unmapped listing without throwing when the projects dir is unreadable',
    async () => {
      const map: PathMap = {
        projects: {
          foo: { 'test-host': '/srv/foo' },
        },
      };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      const projectsDir = join(env.testHome, '.claude', 'projects');
      mkdirSync(join(projectsDir, '-srv-stray'), { recursive: true });
      // Revoke read permission so readdirSync throws (EACCES); the tolerant
      // doctor must skip the listing, not crash mid-output.
      chmodSync(projectsDir, 0o000);
      try {
        const { cmdDoctor } = await import('./commands.doctor.ts');
        cmdDoctor({ verbose: true });
        const out = joinedLog(env.logSpy);
        expect(out).not.toContain('Unmapped local projects');
        // Output continued past the listing: the collision scan still ran.
        expect(out).toContain('path-encoding');
      } finally {
        chmodSync(projectsDir, 0o755);
      }
    },
  );

  it('omits the unmapped header entirely when every local project dir is mapped', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    mkdirSync(join(env.testHome, '.claude', 'projects', '-srv-foo'), { recursive: true });
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Unmapped local projects');
  });

  it('renders each mapped project as a nested connector row under a glyph-free header', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo' },
        bar: { 'other-host': '/srv/bar' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    // Header drops the info glyph; child rows nest one tree level deeper with
    // their own connectors and no glyph. The parent stream continues (the
    // path-encoding row follows), so the child gutter carries the pipe.
    expect(out).toContain('├ Mapped projects for test-host: 1');
    expect(out).not.toContain(`${infoGlyph} mapped projects`);
    expect(out).toContain('  │   └ foo -> /srv/foo');
    expect(out).not.toContain('bar ->');
  });

  // Collisions cause silent data loss in remap, so doctor emits FAIL (not
  // WARN) and sets exitCode=1 so downstream automation can gate on them.
  it('skips TBD and empty abspaths during the collision scan', async () => {
    // `reportPathCollisions` filters out `TBD` placeholders (used before a
    // host is set up) and empty strings before encoding. Without the skip,
    // an unmapped host's `TBD` could collide with another unmapped host's
    // `TBD`, producing a spurious FAIL. The test feeds both `TBD` and `''`
    // and asserts the scanner still PASSes.
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo', 'other-host': 'TBD' },
        bar: { 'test-host': '/srv/bar', 'other-host': '' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${failGlyph} path-encoding collision`);
    expect(out).toContain(`${okGlyph} path-encoding: no collisions`);
  });

  it('emits FAIL with exit code 1 listing both abspaths and the encoded result on collision', async () => {
    // `/foo/bar-baz` and `/foo-bar/baz` both encode to `-foo-bar-baz`
    // because encodePath swaps `/` for `-` without escaping literal dashes.
    // Per-host abspaths in different logical projects share the same encoded
    // dir name, so remap would clobber one with the other.
    const map: PathMap = {
      projects: {
        a: { 'test-host': '/foo/bar-baz', 'other-host': '/X' },
        b: { 'test-host': '/foo-bar/baz', 'other-host': '/Y' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-encoding collision:`);
    expect(out).toContain('/foo/bar-baz');
    expect(out).toContain('/foo-bar/baz');
    expect(out).toContain('-foo-bar-baz');
    expect(process.exitCode).toBe(1);
  });
});

describe('reportPathMap schema validation', () => {
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
    env = makeDoctorEnv({ host: 'test-host', writeSettings: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('FAILs with exitCode=1 when path-map.json is absent', async () => {
    // path-map.json is not written; makeDoctorEnv creates the repo dirs only.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json missing`);
    expect(process.exitCode).toBe(1);
  });

  it('FAILs with exitCode=1 when path-map.json contains malformed JSON', async () => {
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), 'not valid json\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('malformed JSON');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs with exitCode=1 when projects is null', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: null }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('"projects" must be an object');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs with exitCode=1 when projects is an array', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: [{ foo: '/bar' }] }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('"projects" must be an object');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs with exitCode=1 when a project hosts value is null', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { myproj: null } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('"myproj" hosts must be an object');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs with exitCode=1 when a project hosts value is an array', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { myproj: ['/srv/foo'] } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('"myproj" hosts must be an object');
    expect(process.exitCode).toBe(1);
  });

  it('skips exactly the string "TBD" during the collision scan (not a collision)', async () => {
    // The TBD skip uses strict equality. A host value of exactly "TBD" must be
    // excluded from the collision scan; other placeholder-like strings are not
    // special and would be checked normally.
    const map = {
      projects: {
        a: { 'test-host': '/srv/a', 'other-host': 'TBD' },
        b: { 'test-host': '/srv/b', 'third-host': 'TBD' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    // Two separate hosts each have "TBD" -- both are skipped; no collision reported.
    expect(out).not.toContain(`${failGlyph} path-encoding collision`);
    expect(out).toContain(`path-encoding: no collisions`);
    expect(process.exitCode).toBe(0);
  });
});

describe('reportPathMap current-host path missing on disk', () => {
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
    env = makeDoctorEnv({ host: 'test-host', writeSettings: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits a warnGlyph row when the current-host path does not exist on disk', async () => {
    const map: PathMap = {
      projects: { myproj: { 'test-host': '/nonexistent/path/xyz123' } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    // Verify the WARN glyph and the full diagnostic message appear together.
    expect(out).toContain(warnGlyph);
    expect(out).toContain(
      'path-map: myproj local path missing on test-host: /nonexistent/path/xyz123',
    );
  });

  it('stays silent when the current-host path exists on disk', async () => {
    // env.testHome is a real directory created by mkdtempSync, so existsSync returns true.
    const map: PathMap = {
      projects: { myproj: { 'test-host': env.testHome } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('path-map: myproj local path missing');
  });

  it('stays silent when the path-map entry has a value only for another host', async () => {
    // current host is 'test-host'; entry has only 'other-host' -> no warning.
    const map: PathMap = {
      projects: { myproj: { 'other-host': '/nonexistent/path/xyz123' } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('path-map: myproj local path missing');
  });

  it('stays silent when the current-host value is the TBD placeholder', async () => {
    const map: PathMap = {
      projects: { myproj: { 'test-host': 'TBD' } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('path-map: myproj local path missing');
  });

  it('stays silent when the current-host value is an empty string', async () => {
    const map: PathMap = {
      projects: { myproj: { 'test-host': '' } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('path-map: myproj local path missing');
  });

  it('warns only for the missing project when multiple projects are present', async () => {
    // 'present' has an existing path; 'absent' has a nonexistent path.
    const map: PathMap = {
      projects: {
        present: { 'test-host': env.testHome },
        absent: { 'test-host': '/nonexistent/path/xyz123' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'path-map: absent local path missing on test-host: /nonexistent/path/xyz123',
    );
    expect(out).not.toContain('path-map: present local path missing');
  });

  it('does not set process.exitCode when a current-host path is missing', async () => {
    const map: PathMap = {
      projects: { myproj: { 'test-host': '/nonexistent/path/xyz123' } },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    const exitBefore = process.exitCode;
    reportPathMap(sec);
    expect(sec.items.join('\n')).toContain('path-map: myproj local path missing');
    expect(process.exitCode).toBe(exitBefore);
  });
});

describe('reportRejectedSharedDirs', () => {
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
    env = makeDoctorEnv({ host: 'test-host', writeSettings: true });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('prints a top-level WARN row naming a rejected entry and its reason, visible in the default compact view', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env', 'get-shit-done'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('".env"');
    expect(out).toContain('credential-shaped');
    expect(out).toContain(warnGlyph);
    expect(out).not.toContain('get-shit-done');
  });

  it('emits the rejection as a top-level item, not a nested child row', async () => {
    // Structural, not textual: the compact filter keeps a row for its glyph
    // whether or not it is nested, so only the leading-tab child marker
    // distinguishes the two. A child row would outlive its passing parent and
    // render its connector under an unrelated entry.
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const row = sec.items.find((it) => it.includes('sharedDirs entry'));
    expect(row).toBeDefined();
    expect(row?.startsWith('\t')).toBe(false);
  });

  it('leaves process.exitCode untouched when a sharedDirs entry is rejected', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    process.exitCode = 0;
    reportPathMap(sec);
    expect(process.exitCode).toBe(0);
  });

  it('names an existing shared/.env leftover with a remove-by-hand instruction, and does not remove it', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const offenderPath = join(env.testHome, 'claude-nomad', 'shared', '.env');
    writeFileSync(offenderPath, 'SECRET=1\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('shared/.env exists in the repo working tree');
    expect(out).toContain('remove it by hand');
    expect(existsSync(offenderPath)).toBe(true);
  });

  it('leads with copy-the-content-out when ~/.claude/<name> is still a symlink into shared/', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['credentials'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const target = join(env.testHome, 'claude-nomad', 'shared', 'credentials');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'token.txt'), 'SECRET=1\n');
    symlinkSync(target, join(env.testHome, '.claude', 'credentials'));
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('~/.claude/credentials is a symlink into shared/credentials');
    expect(out).toContain('cp -RL');
    // The delete-only row must NOT also fire: following it destroys the copy.
    expect(out).not.toContain('remove it by hand');
    expect(existsSync(join(target, 'token.txt'))).toBe(true);
  });

  it('falls back to the delete-only row when the local probe cannot stat the path', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    writeFileSync(join(env.testHome, 'claude-nomad', 'shared', '.env'), 'SECRET=1\n');
    // Replace ~/.claude with a regular file so the lstat of a path THROUGH it
    // raises instead of reporting absence. The tolerant probe must swallow it.
    rmSync(join(env.testHome, '.claude'), { recursive: true, force: true });
    writeFileSync(join(env.testHome, '.claude'), 'not a directory\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    expect(() => reportPathMap(sec)).not.toThrow();
    const out = sec.items.join('\n');
    expect(out).toContain('exists in the repo working tree');
    expect(out).not.toContain('is a symlink into');
  });

  it('does not print an offender row when the rejected name is absent from shared/', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['.env'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('sharedDirs entry ".env" rejected');
    expect(out).not.toContain('exists in the repo working tree');
  });

  it('stays silent when sharedDirs holds only valid entries', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['get-shit-done'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    expect(sec.items.join('\n')).not.toContain('sharedDirs entry');
  });

  it('stays silent when sharedDirs is absent', async () => {
    const map: PathMap = { projects: {} };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    expect(sec.items.join('\n')).not.toContain('sharedDirs entry');
  });

  it('tolerates a non-array sharedDirs without throwing or aborting the run', async () => {
    const map = { projects: {}, sharedDirs: 'not-an-array' };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    expect(() => reportPathMap(sec)).not.toThrow();
    expect(sec.items.join('\n')).not.toContain('sharedDirs entry');
  });

  it('tolerates non-string sharedDirs members, naming each as not a string, without throwing', async () => {
    const map = { projects: {}, sharedDirs: [42, null, { a: 1 }] };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    expect(() => reportPathMap(sec)).not.toThrow();
    const out = sec.items.join('\n');
    expect(out).toContain('42');
    expect(out).toContain('null');
    expect(out.match(/not a string/g) ?? []).toHaveLength(3);
  });

  it.skipIf(isWin)(
    'tolerates an unreadable shared/ directory: rejection rows still print, offender probe is skipped',
    async () => {
      const map: PathMap = {
        projects: {},
        sharedDirs: ['.env'],
      };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      const sharedDir = join(env.testHome, 'claude-nomad', 'shared');
      chmodSync(sharedDir, 0o000);
      try {
        const { section: makeSection } = await import('./commands.doctor.format.ts');
        const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
        const sec = makeSection('Path map');
        expect(() => reportPathMap(sec)).not.toThrow();
        expect(sec.items.join('\n')).toContain('sharedDirs entry ".env" rejected');
      } finally {
        chmodSync(sharedDir, 0o755);
      }
    },
  );
});
