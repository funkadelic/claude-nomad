import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, infoGlyph, okGlyph, warnGlyph } from './color.ts';
import { type PathMap } from './config.ts';
import { stubPlatform } from './test-helpers.platform.ts';
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

// macOS and Windows default to case-insensitive volumes, where `shared/Plans`
// and `shared/plans` are ONE directory, so the leftover probe finds the entry
// and its row is correct. The negative assertion only holds where they are two.
const caseInsensitiveFs = process.platform === 'darwin' || isWin;

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
    expect(out).toContain('shared/ entry ".env" exists in the repo working tree');
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
    expect(out).toContain('entry "credentials" is a symlink under ~/.claude/');
    expect(out).toContain('cp -RL');
    // The delete-only row must NOT also fire: following it destroys the copy.
    expect(out).not.toContain('remove it by hand');
    expect(existsSync(join(target, 'token.txt'))).toBe(true);
  });

  it('says leave-it-alone for a symlink pointing outside shared/, and still reports the leftover', async () => {
    // A user's own symlink at a name that also appears in sharedDirs. Claiming
    // it "points into shared/" and telling them to remove both would aim the
    // instruction at content nomad never owned. The repo-side leftover is a
    // separate fact and must still be reported, not shadowed by the link.
    const map: PathMap = {
      projects: {},
      sharedDirs: ['credentials'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const foreign = join(env.testHome, 'password-store');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'mine.gpg'), 'user data\n');
    symlinkSync(foreign, join(env.testHome, '.claude', 'credentials'));
    // A genuine repo-side leftover under the same name.
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'credentials'), { recursive: true });

    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('pointing OUTSIDE shared/');
    expect(out).not.toContain('cp -RL');
    expect(out).toContain('exists in the repo working tree');
    expect(existsSync(join(foreign, 'mine.gpg'))).toBe(true);
  });

  it.skipIf(caseInsensitiveFs)(
    'does not name an unrelated directory that merely differs in case',
    async () => {
      // On a case-sensitive filesystem shared/Plans and shared/plans are two
      // different directories, so a folded match would name a real but
      // unrelated one and tell the user to delete it. The probe tests the
      // entry's own path, so the filesystem decides: no row here, and on macOS
      // or NTFS (where they are one directory) the row appears instead.
      const map: PathMap = {
        projects: {},
        sharedDirs: ['Plans'],
      };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'plans'), { recursive: true });

      const { section: makeSection } = await import('./commands.doctor.format.ts');
      const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
      const sec = makeSection('Path map');
      reportPathMap(sec);
      const out = sec.items.join('\n');
      expect(out).toContain('sharedDirs entry "Plans" rejected');
      expect(out).not.toContain('exists in the repo working tree');
    },
  );

  it('names the leftover when the entry resolves on this filesystem', async () => {
    const map: PathMap = {
      projects: {},
      sharedDirs: ['Plans'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'Plans'), { recursive: true });

    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    expect(sec.items.join('\n')).toContain('shared/ entry "Plans" exists in the repo working tree');
  });

  it('never tells the user to remove anything when the local link is dangling', async () => {
    // Whether the link resolves and whether shared/<entry> exists are
    // independent facts. A link left by a moved checkout dangles while the
    // repo-side copy is the only one left, so the delete row here would
    // destroy it.
    const map: PathMap = {
      projects: {},
      sharedDirs: ['credentials'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const onlyCopy = join(env.testHome, 'claude-nomad', 'shared', 'credentials');
    mkdirSync(onlyCopy, { recursive: true });
    writeFileSync(join(onlyCopy, 'token.txt'), 'THE ONLY COPY\n');
    symlinkSync(
      join(env.testHome, 'gone-old-checkout', 'shared', 'credentials'),
      join(env.testHome, '.claude', 'credentials'),
    );

    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('DANGLING symlink');
    expect(out).not.toContain('remove it by hand');
    expect(out).not.toContain('cp -RL');
    expect(existsSync(join(onlyCopy, 'token.txt'))).toBe(true);
  });

  it.skipIf(isWin)(
    'probes a trailing-dot entry on posix, where it is a real distinct name',
    async () => {
      const map: PathMap = { projects: {}, sharedDirs: ['mytools.'] };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'mytools.'), { recursive: true });

      const { section: makeSection } = await import('./commands.doctor.format.ts');
      const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
      const sec = makeSection('Path map');
      reportPathMap(sec);
      expect(sec.items.join('\n')).toContain(
        'shared/ entry "mytools." exists in the repo working tree',
      );
    },
  );

  it.skipIf(isWin)(
    'never probes a trailing-dot entry on win32, where it addresses a different path',
    async () => {
      // The leftover is created WITH the trailing dot. Creating shared/mytools
      // instead would make this pass whether or not the gate exists, since on
      // the posix filesystem this runs on the two are different directories and
      // neither spelling would be found: the assertion has to be able to fail.
      const realPlatform = process.platform;
      try {
        stubPlatform('win32');
        // Includes spellings that inherit never-sync and secret-shaped, both of
        // which ARE probeable causes: a gate keyed on the cause rather than the
        // spelling would let these through.
        const map: PathMap = {
          projects: {},
          sharedDirs: ['mytools.', '.env.', 'settings.local.json.'],
        };
        writeFileSync(
          join(env.testHome, 'claude-nomad', 'path-map.json'),
          JSON.stringify(map) + '\n',
        );
        for (const name of ['mytools.', '.env.', 'settings.local.json.']) {
          mkdirSync(join(env.testHome, 'claude-nomad', 'shared', name), { recursive: true });
        }

        const { section: makeSection } = await import('./commands.doctor.format.ts');
        const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
        const sec = makeSection('Path map');
        reportPathMap(sec);
        const out = sec.items.join('\n');
        expect(out).toContain('rejected');
        expect(out).not.toContain('exists in the repo working tree');
      } finally {
        stubPlatform(realPlatform);
      }
    },
  );

  // Settles on the runner what cannot be observed from posix: whether Node's
  // toNamespacedPath prefixing disables the trailing-dot stripping the whole
  // win32-alias reason rests on. If this fails, the reason is unnecessary.
  it.runIf(isWin)('confirms win32 really does strip a trailing dot from a path', () => {
    // Same syscall the code under test uses. `existsSync` would answer a
    // different question, so a green result here would not license the
    // lstat-based probe in hasSharedLeftover.
    const base = join(env.testHome, 'claude-nomad', 'shared');
    mkdirSync(join(base, 'aliasprobe'), { recursive: true });
    expect(lstatSync(join(base, 'aliasprobe.'), { throwIfNoEntry: false })).toBeDefined();
  });

  it.skipIf(isWin)(
    'reports a leftover stored as a dangling symlink, which existsSync would miss',
    async () => {
      const map: PathMap = { projects: {}, sharedDirs: ['.env'] };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      // A leftover whose own target is gone is still a leftover to clear.
      symlinkSync(
        join(env.testHome, 'vanished'),
        join(env.testHome, 'claude-nomad', 'shared', '.env'),
      );

      const { section: makeSection } = await import('./commands.doctor.format.ts');
      const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
      const sec = makeSection('Path map');
      reportPathMap(sec);
      expect(sec.items.join('\n')).toContain('exists in the repo working tree');
    },
  );

  it.skipIf(isWin)(
    'calls a live outside link foreign, not dangling, when shared/ is absent',
    async () => {
      // The link resolves; it is shared/ that is gone. Reporting it dangling
      // would tell the user a live link is dead and invite removing it.
      const map: PathMap = { projects: {}, sharedDirs: ['credentials'] };
      writeFileSync(
        join(env.testHome, 'claude-nomad', 'path-map.json'),
        JSON.stringify(map) + '\n',
      );
      const elsewhere = join(env.testHome, 'password-store');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(env.testHome, '.claude', 'credentials'));
      rmSync(join(env.testHome, 'claude-nomad', 'shared'), { recursive: true, force: true });

      const { section: makeSection } = await import('./commands.doctor.format.ts');
      const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
      const sec = makeSection('Path map');
      reportPathMap(sec);
      const out = sec.items.join('\n');
      expect(out).toContain('pointing OUTSIDE shared/');
      expect(out).not.toContain('DANGLING');
      expect(existsSync(elsewhere)).toBe(true);
    },
  );

  it('never emits a remediation row for a reserved name nomad manages right now', async () => {
    // ~/.claude/commands is a live symlink into shared/commands, which is
    // tracked and synced to every host. "remove both" would delete it fleet-wide.
    const map: PathMap = {
      projects: {},
      sharedDirs: ['commands'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const managed = join(env.testHome, 'claude-nomad', 'shared', 'commands');
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, 'shipped.md'), '# fleet content\n');
    symlinkSync(managed, join(env.testHome, '.claude', 'commands'));

    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('sharedDirs entry "commands" rejected');
    expect(out).not.toContain('remove both');
    expect(out).not.toContain('remove it by hand');
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
    // Must name the row that actually exists: "is a symlink under ~/.claude/".
    // Asserting on "is a symlink into" would pass no matter what, since no row
    // uses that wording.
    expect(out).not.toContain('is a symlink under');
  });

  it('escapes an ANSI-carrying rejected name instead of emitting it raw', async () => {
    // path-map.json is a trust boundary and its values may hold escape bytes,
    // which would let a crafted name rewrite the WARN rows around it. The
    // rejection row is the only row such a name reaches: an escape byte fails
    // the single-segment check, and a not-a-segment entry is never probed, so
    // the remediation rows below cannot carry one at all.
    const evil = '\u001b[2Kevil';
    const map = { projects: {}, sharedDirs: [evil] };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('rejected: not a single path segment');
    expect(out).toContain('\\u001b[2Kevil');
    expect(out).not.toContain(evil);
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

  it('never probes a traversing entry, so no remediation row claims a path outside ~/.claude/', async () => {
    // "../escape" is rejected as not-a-segment, and join() normalizes "..", so
    // probing it would stat a sibling of ~/.claude/ and report the answer as
    // though it described the configured name. Only reasons the guard tests
    // AFTER its single-segment check are probeable.
    const map: PathMap = {
      projects: {},
      sharedDirs: ['../escape'],
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const outside = join(env.testHome, 'outside-target');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(env.testHome, 'escape'));
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    reportPathMap(sec);
    const out = sec.items.join('\n');
    expect(out).toContain('sharedDirs entry "../escape" rejected');
    expect(out).not.toContain('is a symlink under ~/.claude/');
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

  it('names a non-array sharedDirs in its own row instead of walking it per character', async () => {
    const map = { projects: {}, sharedDirs: 'not-an-array' };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    expect(() => reportPathMap(sec)).not.toThrow();
    const out = sec.items.join('\n');
    expect(out).toContain('sharedDirs is not an array (string)');
    expect(out).not.toContain('sharedDirs entry');
  });

  it('names a non-iterable sharedDirs without throwing', async () => {
    const map = { projects: {}, sharedDirs: 42 };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { section: makeSection } = await import('./commands.doctor.format.ts');
    const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
    const sec = makeSection('Path map');
    expect(() => reportPathMap(sec)).not.toThrow();
    expect(sec.items.join('\n')).toContain('sharedDirs is not an array (number)');
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

  // Root reads through mode 0o000, so the catch branch this test exists for
  // would never execute under a root runner (common in containers) and could
  // silently stop being covered without the patch gate noticing.
  it.skipIf(isWin || process.getuid?.() === 0)(
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
      // A real leftover, so there IS an offender row to suppress. Without it
      // the assertion below passes whether or not the probe was skipped.
      writeFileSync(join(sharedDir, '.env'), 'SECRET=1\n');
      chmodSync(sharedDir, 0o000);
      try {
        const { section: makeSection } = await import('./commands.doctor.format.ts');
        const { reportPathMap } = await import('./commands.doctor.checks.pathmap.ts');
        const sec = makeSection('Path map');
        expect(() => reportPathMap(sec)).not.toThrow();
        const rendered = sec.items.join('\n');
        expect(rendered).toContain('sharedDirs entry ".env" rejected');
        expect(rendered).not.toContain('exists in the repo working tree');
      } finally {
        chmodSync(sharedDir, 0o755);
      }
    },
  );
});
