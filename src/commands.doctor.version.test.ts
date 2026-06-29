import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
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

describe('cmdDoctor version check', () => {
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
    // own. That lets the version-check tests assert "exitCode is not 1"
    // and have the assertion actually mean "the version check did not
    // flip it" rather than "some earlier diagnostic failed".
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

  it('emits PASS version line when local == latest (Test A)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', version: '0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} claude-nomad: 0.11.2 (latest)`);
    // The version check NEVER mutates exitCode; verify alongside the PASS
    // assertion so a future regression cannot silently flip the contract.
    expect(process.exitCode).not.toBe(1);
  });

  it('emits WARN version line when local < latest (Test B)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} claude-nomad: 0.11.2 -> 0.11.3`);
    // The hint must point at the upgrade path; substring is load-bearing
    // because users grep for it in CI logs.
    expect(out).toContain('nomad update');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits informational ahead-of-latest line with no PASS/WARN prefix when local > latest (Test C)', async () => {
    mockPackageJsonVersion('0.12.0');
    mockCurlReleases({ kind: 'json', version: '0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('claude-nomad: 0.12.0 (ahead of latest release 0.11.2)');
    // The ahead branch is informational; it must NOT carry a status token.
    // A regression that prepends PASS/WARN/FAIL would flip the meaning of
    // the line for any dev running a not-yet-released version.
    expect(out).not.toContain(`${okGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(out).not.toContain(`${warnGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(out).not.toContain(`${failGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(process.exitCode).not.toBe(1);
  });

  it('emits the skip line when curl is offline / throws (Test D)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'throw', code: 'ENOENT' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Fetch failure is no longer a silent skip: an informational line says
    // WHY there is no verdict, so "no line" cannot be misread as "current".
    expect(out).toContain(
      'claude-nomad: 0.11.2 (version check skipped: could not determine latest version)',
    );
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits the skip line when curl returns malformed JSON (Test F)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'garbage' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Malformed response surfaces as the informational skip line and must
    // not flip exitCode.
    expect(out).toContain(
      'claude-nomad: 0.11.2 (version check skipped: could not determine latest version)',
    );
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits the skip line when npm registry responds with no version field (Test F2)', async () => {
    // The npm registry could return a valid JSON body with no `version` field
    // (e.g. an unexpected shape). `fetchLatestVersion` must treat that as a
    // silent skip rather than emit PASS/WARN.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'no_version' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'claude-nomad: 0.11.2 (version check skipped: could not determine latest version)',
    );
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits the skip line when npm registry returns a pre-release version (Test F3)', async () => {
    // A pre-release tag like `1.2.3-dev` fails STRICT_SEMVER; `fetchLatestVersion`
    // must gate on the regex and return null so the version line is silently
    // skipped rather than emitting a spurious drift warning.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', version: '1.2.3-dev' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'claude-nomad: 0.11.2 (version check skipped: could not determine latest version)',
    );
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode).not.toBe(1);
  });

  it('emits NO version line when package.json version is the empty string (Test H)', async () => {
    // Drives the falsy branch of `readLocalVersion`'s
    // `typeof parsed.version === 'string' && parsed.version.length > 0`
    // check. With no local version to compare against, the helper must
    // skip silently rather than emit PASS/WARN or set exitCode.
    mockPackageJsonVersion('');
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('claude-nomad:');
    expect(out).not.toMatch(/claude-nomad: \d/);
    expect(process.exitCode).not.toBe(1);
  });

  it('emits NO version line when package.json is missing / throws (Test I)', async () => {
    // Drives the catch branch of `readLocalVersion`. When the file is
    // absent the helper must return null and the version line must be
    // silently omitted without setting exitCode.
    mockPackageJsonVersion(null);
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/claude-nomad: \d/);
    expect(process.exitCode).not.toBe(1);
  });
});
