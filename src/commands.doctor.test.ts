import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { type PathMap } from './config.ts';

type LogSpy = MockInstance<(...args: unknown[]) => void>;
type Env = { testHome: string; logSpy: LogSpy };

function makeDoctorEnv(opts: { host?: string; writeBase?: boolean; writeSettings?: boolean }): Env {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
  process.env.HOME = testHome;
  if (opts.host !== undefined) process.env.NOMAD_HOST = opts.host;
  mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
  mkdirSync(join(testHome, 'claude-nomad', 'hosts'), { recursive: true });
  mkdirSync(join(testHome, '.claude'), { recursive: true });
  if (opts.writeBase !== false) {
    writeFileSync(
      join(testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
  }
  if (opts.writeSettings) {
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
  }
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    // Capture only; assertions inspect call list.
  });
  return { testHome, logSpy };
}

function joinedLog(logSpy: LogSpy): string {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('cmdDoctor settings.json schema sanity', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    // Disable color so substring assertions on plain FAIL/WARN/OK tokens are
    // not split by ANSI escape sequences when pc.isColorSupported flips true
    // (e.g. under CI=true on GitHub Actions).
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits PASS line when settings.json has only known keys', async () => {
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('settings.json schema: known keys only');
    expect(out).not.toContain('WARN settings.json has unknown keys');
  });

  it('emits WARN listing the drift key when settings.json contains an unknown key', async () => {
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', newAnthropicFeature: true }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('WARN settings.json has unknown keys');
    expect(out).toContain('newAnthropicFeature');
  });
});

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
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('stays silent on path-encoding collisions when none exist', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/tmp/foo' },
        bar: { 'test-host': '/tmp/bar' },
      },
    };
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), JSON.stringify(map) + '\n');
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    // D-14 may set exitCode=1 on dev hosts without gitleaks; this test only
    // asserts the path-encoding diagnostic is silent and that no NEW
    // exitCode-setting condition fires from THIS describe's setup.
    expect(joinedLog(env.logSpy)).not.toContain('path-encoding collision');
  });

  // Collisions cause silent data loss in remap, so doctor emits FAIL (not
  // WARN) and sets exitCode=1 so downstream automation can gate on them.
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
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL path-encoding collision:');
    expect(out).toContain('/foo/bar-baz');
    expect(out).toContain('/foo-bar/baz');
    expect(out).toContain('-foo-bar-baz');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor host-override-missing diagnostic', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    // Reset here too: prior test files in the same run (or vitest's own
    // worker bookkeeping) can leave process.exitCode non-zero, which would
    // false-positive the hostFile-exists assertion in Test 1.
    process.exitCode = 0;
    env = makeDoctorEnv({});
  });

  afterEach(() => {
    // Reset BEFORE spy restore so a Test 2 leak of process.exitCode = 1
    // does not surface as a runner failure on a subsequent test.
    process.exitCode = 0;
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('logs the hostFile path when it exists and does not FAIL', async () => {
    process.env.NOMAD_HOST = 'test-host';
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'), '{}\n');
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('host overrides:');
    expect(out).toContain(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'));
    // D-14 may set exitCode=1 on dev hosts without gitleaks; this test only
    // asserts the host-override-missing diagnostic itself does not FAIL.
    expect(out).not.toContain('FAIL no hosts/');
  });

  it('FAILs with exit code 1 and lists candidates when hostFile missing AND settings has drift', async () => {
    process.env.NOMAD_HOST = 'nonexistent-host';
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'dell-wsl.json'), '{}\n');
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'norm-mbp.json'), '{}\n');
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL no hosts/nonexistent-host.json AND settings.json has unbased keys');
    expect(out).toContain('statusLine');
    expect(out).toMatch(/candidates:/);
    expect(out).toContain('dell-wsl.json');
    expect(out).toContain('norm-mbp.json');
    expect(process.exitCode).toBe(1);
  });

  it('logs informational base-only line when hostFile missing AND settings has no drift', async () => {
    process.env.NOMAD_HOST = 'nonexistent-host';
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus' }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('host overrides: none (base-only is fine, no settings drift)');
    // D-14 may log "FAIL gitleaks" on dev hosts without gitleaks; this test
    // only asserts the host-override-missing diagnostic itself does not FAIL.
    expect(out).not.toContain('FAIL no hosts/');
  });
});

describe('cmdDoctor malformed JSON tolerance', () => {
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
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('reports FAIL line and continues when settings.json is malformed', async () => {
    writeFileSync(join(env.testHome, '.claude', 'settings.json'), '{ this is not json');
    // Also write path-map.json so the LATER section runs and we can assert
    // doctor did not abort mid-output.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('settings.json');
    // Sentinel: the never-sync log line lives at the very end of doctor and
    // would not appear if doctor had thrown mid-output.
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL line and continues when path-map.json is malformed', async () => {
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{not valid');
    const { cmdDoctor } = await import('./commands.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('path-map.json');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when shared/settings.base.json is missing', async () => {
    // makeDoctorEnv with writeBase:false leaves no base file.
    rmSync(env.testHome, { recursive: true, force: true });
    env = makeDoctorEnv({ host: 'test-host', writeBase: false });
    const { cmdDoctor } = await import('./commands.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL shared/settings.base.json missing');
    expect(process.exitCode).toBe(1);
  });
});
