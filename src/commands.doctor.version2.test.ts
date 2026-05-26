import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';
import {
  mockCurlReleases,
  mockPackageJsonVersion,
} from './commands.doctor.version.test-helpers.ts';

describe('cmdDoctor version check (cache + tag edge cases)', () => {
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
    // Populate the sandbox so the PRIOR checks (repo state, path-map,
    // host-overrides, SHARED_LINKS, etc.) do not set exitCode=1 on their
    // own, mirroring the primary version-check suite's setup.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
    );
    const sharedClaude = join(env.testHome, 'claude-nomad', 'shared', 'CLAUDE.md');
    writeFileSync(sharedClaude, '# shared\n');
    symlinkSync(sharedClaude, join(env.testHome, '.claude', 'CLAUDE.md'));
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('treats cache with non-finite checked_at as a miss and refetches (Test I)', async () => {
    // `loadCache` must reject entries whose `checked_at` is not a finite
    // number and fall through to a fresh curl. The seeded `0.10.0` must
    // NOT appear; the freshly-fetched `0.11.3` must drive the WARN.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'version-check.json'),
      JSON.stringify({ checked_at: 'not-a-number', latest: '0.10.0' }),
    );
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} version: 0.11.2 -> 0.11.3`);
    expect(out).not.toContain('0.10.0');
    expect(process.exitCode === 1).toBe(false);
  });

  it('treats cache with non-semver latest as a miss and refetches (Test J)', async () => {
    // `loadCache` must reject entries whose `latest` field is not strict
    // MAJOR.MINOR.PATCH and fall through to a fresh curl.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'version-check.json'),
      JSON.stringify({ checked_at: Date.now(), latest: 'not-semver' }),
    );
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} version: 0.11.2 -> 0.11.3`);
    expect(out).not.toContain('not-semver');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when package.json itself is unreadable (Test L)', async () => {
    // Drives the catch arm of `readLocalVersion` (readFileSync throws). The
    // helper must swallow the error and skip silently rather than crash
    // doctor or set exitCode.
    mockPackageJsonVersion(null);
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toMatch(/version: \d/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('treats unparseable cache JSON as a miss and refetches (Test K)', async () => {
    // `loadCache`'s catch block must swallow `JSON.parse` errors and
    // return null, falling through to a fresh curl rather than crashing
    // the whole doctor run on a single corrupted cache file.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'version-check.json'), '{ this is not valid json');
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} version: 0.11.2 -> 0.11.3`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('accepts a tag_name without the leading `v` prefix (Test M)', async () => {
    // GitHub usually returns `tag_name: "v0.11.3"`, but the field is
    // freeform; covers the `startsWith('v')` falsy branch in fetchLatestTag.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} version: 0.11.2 -> 0.11.3`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when tag_name is not strict semver (Test N)', async () => {
    // `tag_name: "beta"` is a string but not MAJOR.MINOR.PATCH.
    // `fetchLatestTag` must reject it and produce a silent skip.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'beta' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when local version has no semver prefix (Test O)', async () => {
    // `reportVersionCheck` peels `^MAJOR.MINOR.PATCH` off the local string
    // for the comparison; an exotic local (e.g. `nightly`) yields no
    // prefix match and must short-circuit to silence.
    mockPackageJsonVersion('nightly');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('does not falsely PASS when local has trailing junk after a semver prefix (Test P)', async () => {
    // Inputs like `1.2.3foo` or `1.2.3.4` previously matched
    // `STRICT_SEMVER_PREFIX` greedily and got truncated to `1.2.3`, which
    // would emit a false PASS against an identical `latest`. The anchored
    // regex now requires `-`, `+`, or end-of-string after the patch.
    mockPackageJsonVersion('0.11.2foo');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });
});
