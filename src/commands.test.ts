import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { enforceAllowList } from './commands.ts';
import { type PathMap } from './config.ts';

describe('enforceAllowList', () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      // Capture only; assertions inspect call list.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows clean status with only allow-listed paths', () => {
    const status = ' M shared/CLAUDE.md\n M hosts/test-host.json\n M path-map.json\n';
    const map: PathMap = { projects: {} };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown path with FATAL message and exits 1', () => {
    const status = ' M random/secret.key\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/secret.key, add to PUSH_ALLOWED in src/config.ts'),
    );
  });

  it('rejects NEVER_SYNC path with FATAL message and exits 1', () => {
    const status = '?? .claude.json\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
  });

  it('allows data-driven shared/projects/<logical>/ when logical is in path-map', () => {
    const status = ' M shared/projects/ha-acwd/session-123.jsonl\n';
    const map: PathMap = {
      projects: { 'ha-acwd': { 'test-host': '/home/test/ha-acwd' } },
    };
    enforceAllowList(status, map);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('anchored prefix prevents shared/agents-x/ matching shared/agents/', () => {
    const status = ' M shared/agents-x/leaked.token\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'to sync shared/agents-x/leaked.token, add to PUSH_ALLOWED in src/config.ts',
      ),
    );
  });

  it('enumerates multiple violations in a single output before exit', () => {
    const status = '?? .claude.json\n M random/foo.bar\n';
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(status, map)).toThrow('exit:1');
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude.json is in NEVER_SYNC and must never be pushed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync random/foo.bar, add to PUSH_ALLOWED in src/config.ts'),
    );
  });
});

describe('cmdDoctor FMT-02 schema sanity', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
    mkdirSync(join(testHome, 'claude-nomad', 'hosts'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    writeFileSync(
      join(testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      // Capture only; assertions inspect call list.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  const joinedLog = (): string =>
    logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');

  it('emits PASS line when settings.json has only known keys', async () => {
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog();
    expect(out).toContain('settings.json schema: known keys only');
    expect(out).not.toContain('WARN settings.json has unknown keys');
  });

  it('emits WARN listing the drift key when settings.json contains an unknown key', async () => {
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', newAnthropicFeature: true }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog();
    expect(out).toContain('WARN settings.json has unknown keys');
    expect(out).toContain('newAnthropicFeature');
  });
});

describe('cmdDoctor FMT-03 collision detection', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
    mkdirSync(join(testHome, 'claude-nomad', 'hosts'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    writeFileSync(
      join(testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      // Capture only; assertions inspect call list.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  const joinedLog = (): string =>
    logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');

  it('stays silent on path-encoding collisions when none exist', async () => {
    const map: PathMap = {
      projects: {
        foo: { 'test-host': '/tmp/foo' },
        bar: { 'test-host': '/tmp/bar' },
      },
    };
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify(map) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    expect(joinedLog()).not.toContain('path-encoding collision');
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
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify(map) + '\n',
    );
    const { cmdDoctor } = await import('./commands.ts');
    cmdDoctor();
    const out = joinedLog();
    expect(out).toContain('WARN path-encoding collision:');
    expect(out).toContain('/foo/bar-baz');
    expect(out).toContain('/foo-bar/baz');
    expect(out).toContain('-foo-bar-baz');
  });
});
