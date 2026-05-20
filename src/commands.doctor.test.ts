import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
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

/**
 * True when `arg` parses as a URL whose host is exactly `api.github.com`.
 * Used by the curl mock to identify the GitHub releases API call without
 * a substring check on the URL (which CodeQL flags as
 * `js/incomplete-url-substring-sanitization`).
 */
function isGithubApiUrl(arg: string): boolean {
  try {
    return new URL(arg).hostname === 'api.github.com';
  } catch {
    return false;
  }
}

/** Restore each env var to its captured original (or delete when unset). */
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/** Mock gitleaks as present so its probe succeeds in the healthy-host tests. */
function mockGitleaksPresent(): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
  vi.resetModules();
}

/**
 * Mock the local `package.json` read inside `commands.doctor.version.ts`.
 * Production code resolves the path via `new URL('../package.json',
 * import.meta.url).pathname`, which lands at the REAL repo root regardless
 * of `$HOME`. We override `node:fs.readFileSync` to intercept any path that
 * ends in `/package.json` and substitute the test version; all other reads
 * (sandbox HOME, settings files, gitleaks probes, etc.) fall through to the
 * real implementation so the rest of `cmdDoctor` behaves normally.
 */
function mockPackageJsonVersion(version: string | null): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      readFileSync: vi.fn(
        (path: fsModule.PathOrFileDescriptor, opts?: Parameters<typeof actual.readFileSync>[1]) => {
          if (typeof path === 'string' && path.endsWith('/package.json')) {
            if (version === null) throw new Error('ENOENT package.json');
            return JSON.stringify({ name: 'claude-nomad', version });
          }
          return actual.readFileSync(path, opts);
        },
      ),
    };
  });
}

/**
 * Mock `node:child_process` so the curl call to the GitHub releases API
 * returns a deterministic response. Behaviors:
 *   - `{ kind: 'json', tagName }`: return a buffer of `{"tag_name":"<tag>"}`
 *   - `{ kind: 'rate_limited' }`: return a GitHub rate-limit JSON payload
 *     (no `tag_name`), so `fetchLatestTag` parses cleanly but finds no tag
 *     and falls through to the silent-skip path.
 *   - `{ kind: 'garbage' }`: return a non-JSON buffer (forces parse failure)
 *   - `{ kind: 'throw' }`: throw with the given error code (default ENOENT
 *     so the offline-skip path looks like curl-missing).
 * The gitleaks probe is always answered with a fake version so it does not
 * pollute `process.exitCode` on dev hosts that lack the binary.
 */
function mockCurlReleases(
  response:
    | { kind: 'json'; tagName: string }
    | { kind: 'rate_limited' }
    | { kind: 'garbage' }
    | { kind: 'throw'; code?: string },
): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
          if (bin === 'curl' && args.some(isGithubApiUrl)) {
            if (response.kind === 'throw') {
              const err = new Error(
                `curl mocked: ${response.code ?? 'ENOENT'}`,
              ) as NodeJS.ErrnoException;
              err.code = response.code ?? 'ENOENT';
              throw err;
            }
            if (response.kind === 'garbage') {
              return Buffer.from('not-json-at-all');
            }
            if (response.kind === 'rate_limited') {
              return Buffer.from(
                JSON.stringify({ message: 'API rate limit exceeded for 127.0.0.1.' }),
              );
            }
            return Buffer.from(JSON.stringify({ tag_name: response.tagName }));
          }
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
    cmdDoctor();
    // The gitleaks-presence diagnostic may set exitCode=1 on dev hosts
    // without gitleaks; this test only asserts the path-encoding diagnostic
    // is silent and that no NEW exitCode-setting condition fires from THIS
    // describe's setup.
    expect(joinedLog(env.logSpy)).not.toContain('path-encoding collision');
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
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('FAIL path-encoding collision');
    expect(out).toContain('PASS path-encoding: no collisions');
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
    // Force gitleaks PASS so `process.exitCode === 1` assertions in this
    // block reflect only the malformed-JSON / schema branch under test. On a
    // dev host without gitleaks the probe would set exitCode=1 independently
    // and a regression in the JSON-handling branch could go unnoticed.
    mockGitleaksPresent();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    // vi.restoreAllMocks does NOT clear vi.doMock module mocks; explicitly
    // unmock so the gitleaks-PASS mock does not leak into later describes.
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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

  it('reports FAIL invalid schema and continues when path-map.json parses to a non-object projects field', async () => {
    // path-map.json is valid JSON but schema-invalid. Without the projects
    // guard, Object.entries(map.projects) throws and aborts doctor output
    // mid-stream, violating the tolerant-doctor contract.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL path-map.json invalid schema');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when projects field is an array instead of an object', async () => {
    // Arrays are typeof === 'object', so a bare `typeof !== 'object'` check
    // misses them. Without the Array.isArray guard, the helpers would iterate
    // a non-map shape and emit garbage rows.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{"projects":[]}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('FAIL path-map.json invalid schema');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when a project entry maps to null instead of a hosts object', async () => {
    // Per-project guard: `hosts[HOST]` and `Object.values(hosts)` would throw
    // if `hosts` is null. Without the per-entry validation, helpers crash
    // mid-output and break the tolerant-doctor contract.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{"projects":{"foo":null}}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'FAIL path-map.json invalid schema: project "foo" hosts must be an object',
    );
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when a project entry maps to a primitive instead of a hosts object', async () => {
    // Same guard as the null case, but covering the typeof !== 'object' branch.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      '{"projects":{"foo":"bar"}}',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'FAIL path-map.json invalid schema: project "foo" hosts must be an object',
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when a host value is a non-string primitive', async () => {
    // The hosts-shape check accepts `{ host: <anything> }` as long as it is an
    // object. Without the per-host string check, a number value flows into
    // encodePath() and throws mid-output, breaking the tolerant-doctor contract.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      '{"projects":{"foo":{"test-host":123}}}',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor()).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      'FAIL path-map.json invalid schema: project "foo" host "test-host" path must be a string',
    );
    expect(out).toContain('never-sync items:');
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('logs PASS-equivalent version line when gitleaks IS on PATH', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
            if (bin === 'gitleaks' && args[0] === 'version') {
              return Buffer.from('v8.18.2\n');
            }
            return actual.execFileSync(bin, args, opts);
          },
        ),
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
        execFileSync: vi.fn(
          (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
            if (bin === 'gitleaks' && args[0] === 'version') {
              const err = new Error('spawn gitleaks ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            return actual.execFileSync(bin, args, opts);
          },
        ),
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
        execFileSync: vi.fn(
          (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
            if (bin === 'gitleaks' && args[0] === 'version') {
              const err = new Error('permission denied') as NodeJS.ErrnoException;
              err.code = 'EACCES';
              throw err;
            }
            return actual.execFileSync(bin, args, opts);
          },
        ),
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
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
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('reports FAIL and sets exitCode=1 when a SHARED_LINKS entry exists as a regular file in ~/.claude/', async () => {
    // Place a regular file (not a symlink) at ~/.claude/CLAUDE.md. The
    // SHARED_LINKS loop's lstatSync().isSymbolicLink() branch must surface
    // the blocks-sync diagnostic as an explicit FAIL and mark the run failed
    // so scripts and CI catch the regression.
    writeFileSync(join(env.testHome, '.claude', 'CLAUDE.md'), '# regular file\n');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('CLAUDE.md: FAIL NOT a symlink (blocks sync)');
    expect(process.exitCode).toBe(1);
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
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
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
      JSON.stringify({ projects: { foo: { 'test-host': '/srv/foo' } } }) + '\n',
    );
    // Real symlink so the SHARED_LINKS loop hits its success branch.
    const sharedClaude = join(env.testHome, 'claude-nomad', 'shared', 'CLAUDE.md');
    writeFileSync(sharedClaude, '# shared\n');
    symlinkSync(sharedClaude, join(env.testHome, '.claude', 'CLAUDE.md'));
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
    expect(out).not.toMatch(/PASS host overrides:/);
    expect(out).not.toMatch(/PASS never-sync items:/);
    expect(out).not.toMatch(/PASS remote origin:/);
  });

  it('annotates repo and claude-home paths with MISSING when their directories are absent', async () => {
    // The healthy-host setup is already in place via makeDoctorEnv. Tear down
    // both REPO_HOME (~/claude-nomad) and CLAUDE_HOME (~/.claude) to exercise
    // the falsy branches of the existsSync ternaries inside reportHostAndPaths.
    rmSync(join(env.testHome, 'claude-nomad'), { recursive: true, force: true });
    rmSync(join(env.testHome, '.claude'), { recursive: true, force: true });
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toMatch(/repo: .*MISSING/);
    expect(out).toMatch(/claude home: .*MISSING/);
  });

  it('emits tree-style section headers and bullet prefixes (Claude /doctor style)', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Section headers print without prefix or indent.
    expect(out).toMatch(/^Host$/m);
    expect(out).toMatch(/^Shared links$/m);
    expect(out).toMatch(/^Settings$/m);
    expect(out).toMatch(/^Path map$/m);
    expect(out).toMatch(/^Repository$/m);
    // Items use the tree-branch glyphs and never carry the legacy `[nomad]` prefix.
    expect(out).toMatch(/^ {2}[├└] /m);
    expect(out).not.toContain('[nomad]');
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
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS version: 0.11.2 (latest)');
    // The version check NEVER mutates exitCode; verify alongside the PASS
    // assertion so a future regression cannot silently flip the contract.
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits WARN version line when local < latest (Test B)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
    // The hint must point at the upgrade path; substring is load-bearing
    // because users grep for it in CI logs.
    expect(out).toContain('nomad update');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits informational ahead-of-latest line with no PASS/WARN prefix when local > latest (Test C)', async () => {
    mockPackageJsonVersion('0.12.0');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('version: 0.12.0 (ahead of latest release 0.11.2)');
    // The ahead branch is informational; it must NOT carry a status token.
    // A regression that prepends PASS/WARN/FAIL would flip the meaning of
    // the line for any dev running a not-yet-released version.
    expect(out).not.toMatch(/(PASS|WARN|FAIL) version: 0\.12\.0 \(ahead/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when curl is offline / throws (Test D)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'throw', code: 'ENOENT' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Silent-skip means zero `version:` output. We assert on the substring
    // rather than the full line so a future addition (e.g. dim-blue debug
    // hint) would still be caught by this test.
    expect(out).not.toContain('version: 0.11.2');
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('reuses fresh cache entry without calling curl (Test E)', async () => {
    // Pre-seed a fresh cache (within the 1h TTL). Mock curl to THROW so the
    // assertion "PASS line was emitted" can only be true if the cache hit
    // short-circuited the fetch. If the cache were missed, the throwing
    // curl mock would trigger the silent-skip path instead.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'version-check.json'),
      JSON.stringify({ checked_at: Date.now(), latest: '0.11.2' }),
    );
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'throw', code: 'ENOENT' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('PASS version: 0.11.2 (latest)');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when curl returns malformed JSON (Test F)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'garbage' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Malformed-response is one of the silent-skip paths; doctor must
    // emit no version-related line and must not flip exitCode.
    expect(out).not.toContain('version: 0.11.2');
    expect(out).not.toContain('ahead of latest release');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when GitHub responds with a rate-limit payload (Test F2)', async () => {
    // GitHub's anon API limit is 60 req/h; over the limit it returns a
    // valid JSON body with `message` but no `tag_name`. `fetchLatestTag`
    // must treat that as a silent skip rather than emit PASS/WARN.
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'rate_limited' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/PASS version|WARN version|ahead of latest release/);
    expect(process.exitCode === 1).toBe(false);
  });

  it('refetches when cache is stale beyond the 1h TTL (Test G)', async () => {
    // Pre-seed a STALE cache (2h old). The TTL gate must reject it and the
    // mock curl response must drive the diagnostic. If the gate were
    // broken (e.g. > vs <), the WARN line below would carry the stale
    // tag `0.10.0` instead of the fresh `0.11.3`.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'version-check.json'),
      JSON.stringify({ checked_at: Date.now() - 2 * 60 * 60 * 1000, latest: '0.10.0' }),
    );
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
    expect(out).not.toContain('0.10.0');
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when package.json version is the empty string (Test H)', async () => {
    // Drives the falsy branch of `readLocalVersion`'s
    // `typeof parsed.version === 'string' && parsed.version.length > 0`
    // check. With no local version to compare against, the helper must
    // skip silently rather than emit PASS/WARN or set exitCode.
    mockPackageJsonVersion('');
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.3' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/PASS version|WARN version|version: \d/);
    expect(process.exitCode === 1).toBe(false);
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
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
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
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
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
    expect(out).not.toMatch(/PASS version|WARN version|version: \d/);
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
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
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
    expect(out).toContain('WARN version: 0.11.2 -> 0.11.3');
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
    expect(out).not.toMatch(/PASS version|WARN version|ahead of latest release/);
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
    expect(out).not.toMatch(/PASS version|WARN version|ahead of latest release/);
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
    expect(out).not.toMatch(/PASS version|WARN version|ahead of latest release/);
    expect(process.exitCode === 1).toBe(false);
  });
});

describe('compareSemver', () => {
  it('returns 0 for equal MAJOR.MINOR.PATCH', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when a has a higher major and -1 when lower', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a has a higher minor and -1 when lower (same major)', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.5.0', '1.4.9')).toBe(1);
    expect(compareSemver('1.4.0', '1.5.0')).toBe(-1);
  });

  it('returns 1 when a has a higher patch and -1 when lower (same major/minor)', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.0.5', '1.0.4')).toBe(1);
    expect(compareSemver('1.0.4', '1.0.5')).toBe(-1);
  });

  it('returns 0 when either input fails the strict MAJOR.MINOR.PATCH regex', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('not-semver', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });
});
