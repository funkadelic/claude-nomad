import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  setNodeVersion,
} from './commands.doctor.version.test-helpers.ts';

describe('parseMinVersion', () => {
  it('peels the bare version out of `>=X.Y.Z`', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('>=22.22.1')).toBe('22.22.1');
  });

  it('tolerates optional whitespace after `>=`', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('>= 22.22.1')).toBe('22.22.1');
  });

  it('returns null for caret ranges', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('^22.22.1')).toBeNull();
  });

  it('returns null for tilde ranges', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('~22.22.1')).toBeNull();
  });

  it('returns null for bare versions with no operator', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('22.22.1')).toBeNull();
  });

  it('returns null for OR-combined ranges', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('>=22.0.0 || >=24.0.0')).toBeNull();
  });

  it('returns null for an empty string', async () => {
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('')).toBeNull();
  });
});

describe('cmdDoctor node-engine check', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let originalNodeVersion: string;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    originalNodeVersion = process.version;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
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
    Object.defineProperty(process, 'version', {
      value: originalNodeVersion,
      configurable: true,
    });
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits PASS when current node equals the engines minimum', async () => {
    setNodeVersion('v22.22.1');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} node: v22.22.1 (satisfies >=22.22.1)`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits PASS when current node is above the engines minimum', async () => {
    setNodeVersion('v24.0.0');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} node: v24.0.0 (satisfies >=22.22.1)`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits WARN (no exitCode change) when current node is below the engines minimum', async () => {
    setNodeVersion('v22.16.0');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} node: v22.16.0 (below required >=22.22.1`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO node line when engines field is missing', async () => {
    setNodeVersion('v22.22.1');
    mockPackageJsonVersion('0.22.3', null);
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO node line when engines.node uses unsupported range syntax', async () => {
    setNodeVersion('v22.22.1');
    mockPackageJsonVersion('0.22.3', { node: '^22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO node line when process.version is non-strict (e.g. prerelease build)', async () => {
    // Prerelease/nightly Node builds can ship a process.version like
    // `v22.0.0-rc.1` that fails the strict-semver regex. Without the strict
    // guard inside reportNodeEngineCheck, compareSemver would return 0 for
    // such inputs and fall through to a falsely green "satisfies" line.
    setNodeVersion('v22.0.0-rc.1');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });
});
