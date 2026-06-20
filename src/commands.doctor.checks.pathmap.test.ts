import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, infoGlyph, okGlyph } from './color.ts';
import { type PathMap } from './config.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

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

  it('skips the unmapped listing without throwing when the projects dir is unreadable', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/srv/foo' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
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
  });

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
