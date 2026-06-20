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

  it('returns null when `>=X.Y.Z` is not at the start of the string', async () => {
    // Kills the L24 `^`-removal regex mutation: without the start anchor the
    // spec `foo>=22.22.1` would match and produce `22.22.1`, but it is not a
    // valid ENGINES_GTE value so the parser must return null.
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('foo>=22.22.1')).toBeNull();
  });

  it('returns null when there is trailing content after `>=X.Y.Z`', async () => {
    // Kills the L24 `$`-removal regex mutation: without the end anchor the spec
    // `>=22.22.1 extra` would match and produce `22.22.1`, but the trailing
    // content makes it an unsupported range and the parser must return null.
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('>=22.22.1 extra')).toBeNull();
  });

  it('parses a multi-digit patch version (`>=X.Y.ZZ`)', async () => {
    // Kills the L24 `\d+`-to-`\d` regex mutation in the patch group: `\d`
    // matches only a single digit, so `>=22.22.10` would return null under the
    // mutation. The original `\d+` must capture the full two-digit patch.
    const { parseMinVersion } = await import('./commands.doctor.engine.ts');
    expect(parseMinVersion('>=22.22.10')).toBe('22.22.10');
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
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} node: v22.22.1`);
    expect(out).not.toContain('satisfies');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits PASS when current node is above the engines minimum', async () => {
    setNodeVersion('v24.0.0');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} node: v24.0.0`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits WARN (no exitCode change) when current node is below the engines minimum', async () => {
    setNodeVersion('v22.16.0');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
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
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits PASS when process.version has a multi-digit patch number', async () => {
    // Kills the L80 `\d+`-to-`\d` regex mutation in the strict-semver guard:
    // `\d` only matches one digit, so `v22.22.10` (patch=10) would fail the
    // guard and trigger a silent skip instead of the expected PASS line.
    setNodeVersion('v22.22.10');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toMatch(/node: v22\.22\.10/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO node line when process.version has extra components (four-part)', async () => {
    // Kills the L80 `^`-removal regex mutation in the strict-semver guard:
    // without the start anchor, `1.22.0.0` would match `\d+\.\d+\.\d+` at its
    // tail and pass the guard, producing a false PASS. The original anchored
    // regex must reject this non-standard four-part version.
    setNodeVersion('v1.22.0.0');
    mockPackageJsonVersion('0.22.3', { node: '>=22.22.1' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO node line when engines.node is an empty string', async () => {
    // Kills the L49 `node.length > 0` mutation in readEnginesNode: without
    // the length check, an empty-string engines.node would pass through as a
    // valid spec rather than triggering the null-return silent-skip path.
    setNodeVersion('v22.22.1');
    mockPackageJsonVersion('0.22.3', { node: '' });
    mockCurlReleases({ kind: 'json', version: '0.22.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/node: v/);
    expect(process.exitCode === 1).toBe(false);
  });
});
