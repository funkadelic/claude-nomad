import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { type PathMap } from './config.ts';

type LogSpy = MockInstance<(...args: unknown[]) => void>;
type Env = { testHome: string; logSpy: LogSpy };

/**
 * Build a sandbox env for `cmdDoctor` tests: creates a temp `HOME` with the
 * expected `claude-nomad/{shared,hosts}` and `.claude/` skeletons, optionally
 * writes `settings.base.json` (default on), optionally writes a
 * `.claude/settings.json` (default off), and optionally initializes a git
 * repo at `REPO_HOME` (default off; needed for the remote-URL and
 * rebase-clean-tree diagnostics). Returns the temp dir plus a `console.log`
 * spy so callers can assert on doctor's output.
 */
function makeDoctorEnv(opts: {
  host?: string;
  writeBase?: boolean;
  writeSettings?: boolean;
  setupGitRepo?: boolean;
}): Env {
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
  if (opts.setupGitRepo) {
    // Initialize a real git repo at REPO_HOME so cmdDoctor's remote-URL and
    // rebase-clean-tree-WARN git invocations can run against it.
    // --quiet suppresses git's "hint: Using 'master' as the name..." stderr;
    // -b main pins the initial branch to avoid host-specific defaults.
    execFileSync('git', ['init', '--quiet', '-b', 'main'], {
      cwd: join(testHome, 'claude-nomad'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    // Capture only; assertions inspect call list.
  });
  return { testHome, logSpy };
}

/** Concatenate every captured `console.log` call into a single newline-joined
 * string, so tests can assert on substrings without iterating `mock.calls`. */
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    // The gitleaks-presence diagnostic may set exitCode=1 on dev hosts
    // without gitleaks; this test only asserts the path-encoding diagnostic
    // is silent and that no NEW exitCode-setting condition fires from THIS
    // describe's setup.
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('host overrides:');
    expect(out).toContain(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'));
    // The gitleaks-presence diagnostic may set exitCode=1 on dev hosts
    // without gitleaks; this test only asserts the host-override-missing
    // diagnostic itself does not FAIL.
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('host overrides: none (base-only is fine, no settings drift)');
    // The gitleaks-presence diagnostic may log "FAIL gitleaks" on dev hosts
    // without gitleaks; this test only asserts the host-override-missing
    // diagnostic itself does not FAIL.
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
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
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL shared/settings.base.json missing');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL and sets exitCode=1 when path-map.json is missing', async () => {
    // makeDoctorEnv does not write path-map.json by default; assert the
    // missing-file FAIL path so doctor matches cmdPush's hard-stop behavior.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL path-map.json missing');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when shared/settings.base.json is malformed (even without settings.json)', async () => {
    // Overwrite the valid base with garbage, leaving settings.json absent.
    // Pre-fix, base was only parsed when settings.json existed, so this
    // scenario silently passed even though cmdPull would die on it.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      '{ not valid',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('settings.base.json');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when hosts/<HOST>.json is malformed', async () => {
    // Write a garbage host file. Pre-fix, doctor never parsed it — pull's
    // deep-merge would be the first place the malformed JSON surfaced.
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'), '{ not valid');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('test-host.json');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor gitleaks presence', () => {
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
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('logs PASS-equivalent version line when gitleaks IS on PATH', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args: readonly string[], opts?: unknown) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts as never);
        }),
      };
    });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('gitleaks:');
    expect(out).toMatch(/v\d+\.\d+/);
    expect(out).not.toContain('FAIL gitleaks');
    expect(out).toContain('never-sync items:');
  });

  it('logs FAIL and sets exitCode=1 when gitleaks is NOT on PATH (ENOENT)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args: readonly string[], opts?: unknown) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            const err = new Error('spawn gitleaks ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          }
          return actual.execFileSync(bin, args, opts as never);
        }),
      };
    });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('gitleaks');
    expect(out).toContain('not on PATH');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('logs FAIL with probe-failed message when gitleaks errors with non-ENOENT', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args: readonly string[], opts?: unknown) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return actual.execFileSync(bin, args, opts as never);
        }),
      };
    });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('gitleaks');
    expect(out).toContain('probe failed');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor gitlink scan', () => {
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

  it('emits no gitlink FAIL when shared/ has no nested .git entries', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('FAIL gitlink');
    expect(out).toContain('never-sync items:');
  });

  it('emits FAIL gitlink and exitCode=1 for a nested .git directory', async () => {
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'foo', '.git'), { recursive: true });
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'foo', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('gitlink:');
    expect(out).toContain('shared/foo/.git');
    expect(out).toContain('would push as submodule');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('emits FAIL gitlink and exitCode=1 for a .git FILE (submodule gitlink pointer)', async () => {
    mkdirSync(join(env.testHome, 'claude-nomad', 'shared', 'sub'), { recursive: true });
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'sub', '.git'),
      'gitdir: ../.git/modules/sub\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL');
    expect(out).toContain('gitlink:');
    expect(out).toContain('shared/sub/.git');
    expect(out).toContain('would push as submodule');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });
});

describe('cmdDoctor remote URL', () => {
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
    env = makeDoctorEnv({ host: 'test-host', setupGitRepo: true });
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

  it('logs configured origin URL when remote is set', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:foo/bar.git'], {
      cwd: join(env.testHome, 'claude-nomad'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('remote origin:');
    expect(out).toContain('git@example.com:foo/bar.git');
    expect(out).toContain('never-sync items:');
  });

  it('logs "remote origin: not configured" when no remote is set', async () => {
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('remote origin: not configured');
    expect(out).toContain('never-sync items:');
  });
});

describe('cmdDoctor rebase clean-tree WARN', () => {
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
    env = makeDoctorEnv({ host: 'test-host', setupGitRepo: true });
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

  it('emits no WARN when REPO_HOME working tree is clean', async () => {
    // makeDoctorEnv writes settings.base.json before git init, so the file
    // appears untracked; commit it (with local identity) to produce a clean
    // tree without disturbing process-global git config.
    const repo = join(env.testHome, 'claude-nomad');
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('has uncommitted changes');
    expect(out).toContain('never-sync items:');
  });

  it('emits WARN line when REPO_HOME has uncommitted changes', async () => {
    writeFileSync(join(env.testHome, 'claude-nomad', 'dirty.txt'), 'not committed\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('WARN');
    expect(out).toContain('~/claude-nomad/');
    expect(out).toContain('has uncommitted changes');
    expect(out).toContain('--autostash');
    expect(out).toContain('never-sync items:');
  });
});

describe('cmdDoctor repo-state header', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    // NO_COLOR=1 so substring asserts on `PASS`/`WARN`/`FAIL` aren't split
    // by ANSI escapes (matches the convention in every other doctor describe
    // block in this file).
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host', writeBase: false });
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

  it('emits FAIL empty with init-hint and sets exitCode=1 when scaffold is absent', async () => {
    // Fresh sandbox: makeDoctorEnv with writeBase:false leaves no
    // settings.base.json. The empty branch should fire.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('repo state: FAIL empty');
    expect(out).toContain("run 'nomad init' to scaffold");
    expect(process.exitCode).toBe(1);
  });

  it('emits WARN partial with path-map.json missing suffix when only base is present', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // base present, path-map.json missing -> partial with the second priority
    // suffix (settings.base.json missing is suffix #1; path-map.json missing
    // is suffix #2 and fires next).
    expect(out).toContain('repo state: WARN partial - path-map.json missing');
  });

  it('emits WARN partial with hosts/<HOST>.json missing suffix when base + path-map populated', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // base + populated path-map.projects, host file missing -> partial with
    // the hosts/<HOST>.json suffix (priority order #4).
    expect(out).toContain('repo state: WARN partial - hosts/test-host.json missing');
  });

  it('emits WARN partial with empty-projects suffix when path-map.json exists but has zero entries', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('repo state: WARN partial - path-map.json.projects has no entries');
  });

  it('emits PASS populated when settings.base.json + populated path-map + hosts/<host>.json all present', async () => {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('repo state: PASS populated');
  });

  it('logs the repo state line above the SHARED_LINKS / symlink section', async () => {
    // Place a regular file (NOT a symlink) at ~/.claude/CLAUDE.md so the
    // SHARED_LINKS loop emits a 'symlink' substring (the "NOT a symlink" or
    // "symlink OK" branch). The repo-state line is fixed to land before the
    // SHARED_LINKS loop, so its index must precede the first 'symlink' hit.
    writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# placeholder\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    const repoIdx = out.indexOf('repo state:');
    const symlinkIdx = out.indexOf('symlink');
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(symlinkIdx).toBeGreaterThan(repoIdx);
  });
});

describe('cmdDoctor SHARED_LINKS symlink integrity', () => {
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

  it('reports NOT a symlink when a SHARED_LINKS entry exists as a regular file in ~/.claude/', async () => {
    // Place a regular file (not a symlink) at ~/.claude/CLAUDE.md. The
    // SHARED_LINKS loop's lstatSync().isSymbolicLink() branch should report
    // the blocks-sync diagnostic.
    writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# regular file\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('CLAUDE.md: NOT a symlink (blocks sync)');
  });
});

describe('cmdDoctor explicit PASS tokens', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    // NO_COLOR=1 so PASS substring assertions are not split by ANSI escapes
    // (matches the convention used in every other doctor describe block).
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(env.testHome, { recursive: true, force: true });
  });

  /**
   * Build a "fully healthy" sandbox for the PASS-token tests: populated repo
   * (settings.base.json, path-map.json, hosts/test-host.json), known-keys-only
   * settings.json, a real symlink at ~/.claude/CLAUDE.md so the SHARED_LINKS
   * loop exercises its success branch, and a gitleaks mock so the probe
   * succeeds even on dev hosts without the binary on PATH.
   */
  function populateHealthy(): void {
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'),
      JSON.stringify({}) + '\n',
    );
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // Real symlink so the SHARED_LINKS loop hits its success branch.
    const sharedClaude = join(env.testHome, 'claude-nomad', 'shared', 'CLAUDE.md');
    writeFileSync(sharedClaude, '# shared\n');
    execFileSync('ln', ['-s', sharedClaude, join(env.testHome, '.claude', 'CLAUDE.md')]);
  }

  /** Mock gitleaks as present so its probe succeeds in the healthy-host tests. */
  function mockGitleaksPresent(): void {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args: readonly string[], opts?: unknown) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts as never);
        }),
      };
    });
    vi.resetModules();
  }

  it('emits at least 5 PASS tokens on a fully-healthy host', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    const passCount = out.match(/PASS/g)?.length ?? 0;
    // One per check: repo state, SHARED_LINKS (1 real symlink), settings
    // schema, host overrides, path-encoding, gitleaks, gitlink scan.
    expect(passCount).toBeGreaterThanOrEqual(5);
  });

  it('prepends PASS to the settings.json schema line when all keys are known', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS settings.json schema: known keys only');
  });

  it('emits PASS path-encoding when no encoded-dir collisions exist', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS path-encoding: no collisions');
  });

  it('prepends PASS to the gitleaks version line when gitleaks is present', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS gitleaks:');
    expect(out).toMatch(/v\d+\.\d+/);
  });

  it('emits PASS gitlink scan when shared/ contains no nested .git entries', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS gitlink scan:');
  });

  it('replaces "symlink OK" with "PASS symlink" on a valid SHARED_LINKS entry', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Positive: new PASS-prefixed phrasing for the symlink success branch.
    expect(out).toContain('PASS symlink');
    // Negative: the legacy literal must be gone (load-bearing per plan W-1).
    expect(out).not.toContain('symlink OK');
  });

  it('emits WARN when a SHARED_LINKS entry is missing from ~/.claude/', async () => {
    // No real symlink and no regular-file placeholder. The loop's
    // !existsSync branch should emit the explicit WARN token.
    populateHealthy();
    mockGitleaksPresent();
    // Remove the symlink populateHealthy created so CLAUDE.md is missing.
    rmSync(join(env.testHome, '.claude', 'CLAUDE.md'));
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('WARN CLAUDE.md: missing');
  });

  it('does not prefix informational header lines with PASS', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Header lines stay unprefixed; only check-result lines carry the token.
    expect(out).not.toMatch(/PASS host:/);
    expect(out).not.toMatch(/PASS repo:/);
    expect(out).not.toMatch(/PASS claude home:/);
    expect(out).not.toMatch(/PASS mapped projects for/);
    expect(out).not.toMatch(/PASS never-sync items:/);
    expect(out).not.toMatch(/PASS remote origin:/);
  });

  it('preserves the exit-code contract: a fully-healthy host does not set exitCode=1', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    // PASS does not mutate exitCode; only FAIL does. undefined and 0 both pass.
    expect(process.exitCode === 1).toBe(false);
  });
});
