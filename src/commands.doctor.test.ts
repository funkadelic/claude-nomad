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

describe('cmdDoctor FMT-02 schema sanity', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
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

describe('cmdDoctor FMT-03 collision detection', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    env = makeDoctorEnv({ host: 'test-host', writeSettings: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
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
    expect(joinedLog(env.logSpy)).not.toContain('path-encoding collision');
  });

  it('emits WARN listing both abspaths and the encoded result on Pitfall 7 collision', async () => {
    // RESEARCH.md Pitfall 7: `/foo/bar-baz` and `/foo-bar/baz` both encode to
    // `-foo-bar-baz`. Per-host abspaths in different logical projects share
    // the same encoded dir name, so remap would clobber one with the other.
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
    expect(out).toContain('WARN path-encoding collision:');
    expect(out).toContain('/foo/bar-baz');
    expect(out).toContain('/foo-bar/baz');
    expect(out).toContain('-foo-bar-baz');
  });
});

describe('cmdDoctor FMT-04 host-override-missing', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    // Reset here too: prior test files in the same run (or vitest's own
    // worker bookkeeping) can leave process.exitCode non-zero, which would
    // false-positive the hostFile-exists assertion in Test 1.
    process.exitCode = 0;
    env = makeDoctorEnv({});
  });

  afterEach(() => {
    // Reset BEFORE spy restore so a Test 2 leak of process.exitCode = 1 does
    // not surface as a runner failure on a subsequent test. Per plan 02-07
    // Task 2 step 2.
    process.exitCode = 0;
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
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
    expect(out).not.toContain('FAIL no hosts/');
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
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
    expect(out).not.toContain('FAIL');
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });
});
