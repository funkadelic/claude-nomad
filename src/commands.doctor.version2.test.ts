import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warnGlyph } from './color.ts';
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

describe('cmdDoctor version check (tag edge cases)', () => {
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

  it('emits NO version line when package.json itself is unreadable (Test L)', async () => {
    // Drives the catch arm of `readLocalVersion` (readFileSync throws). The
    // helper must swallow the error and skip silently rather than crash
    // doctor or set exitCode.
    mockPackageJsonVersion(null);
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('claude-nomad:');
    expect(out).not.toMatch(/claude-nomad: \d/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('correctly reports drift when npm version is bare semver (Test M)', async () => {
    // The npm registry `version` field is always bare semver (no leading `v`).
    // Confirms the fetch parses it correctly and emits the WARN drift line.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} claude-nomad: 0.11.2 -> 0.11.3`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when npm version field is not strict semver (Test N)', async () => {
    // A non-MAJOR.MINOR.PATCH version string (e.g. `"beta"`) must be
    // rejected by the STRICT_SEMVER gate in `fetchLatestVersion`, producing
    // a silent skip.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', version: 'beta' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('claude-nomad:');
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when local version has no semver prefix (Test O)', async () => {
    // `reportVersionCheck` peels `^MAJOR.MINOR.PATCH` off the local string
    // for the comparison; an exotic local (e.g. `nightly`) yields no
    // prefix match and must short-circuit to silence.
    mockPackageJsonVersion('nightly');
    mockCurlReleases({ kind: 'json', version: '0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('claude-nomad:');
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('does not falsely PASS when local has trailing junk after a semver prefix (Test P)', async () => {
    // Inputs like `1.2.3foo` or `1.2.3.4` previously matched
    // `STRICT_SEMVER_PREFIX` greedily and got truncated to `1.2.3`, which
    // would emit a false PASS against an identical `latest`. The anchored
    // regex now requires `-`, `+`, or end-of-string after the patch.
    mockPackageJsonVersion('0.11.2foo');
    mockCurlReleases({ kind: 'json', version: '0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('claude-nomad:');
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });
});
