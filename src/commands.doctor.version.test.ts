import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    mockCurlReleases({ kind: 'json', tagName: 'v0.11.2' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} claude-nomad: 0.11.2 (latest)`);
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
    expect(out).toContain(`${warnGlyph} claude-nomad: 0.11.2 -> 0.11.3`);
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
    expect(out).toContain('claude-nomad: 0.12.0 (ahead of latest release 0.11.2)');
    // The ahead branch is informational; it must NOT carry a status token.
    // A regression that prepends PASS/WARN/FAIL would flip the meaning of
    // the line for any dev running a not-yet-released version.
    expect(out).not.toContain(`${okGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(out).not.toContain(`${warnGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(out).not.toContain(`${failGlyph} claude-nomad: 0.12.0 (ahead`);
    expect(process.exitCode === 1).toBe(false);
  });

  it('emits NO version line when curl is offline / throws (Test D)', async () => {
    mockPackageJsonVersion('0.11.2');
    mockCurlReleases({ kind: 'throw', code: 'ENOENT' });
    vi.resetModules();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Silent-skip means zero `claude-nomad:` output. We assert on the substring
    // rather than the full line so a future addition (e.g. dim-blue debug
    // hint) would still be caught by this test.
    expect(out).not.toContain('claude-nomad: 0.11.2');
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
    expect(out).toContain(`${okGlyph} claude-nomad: 0.11.2 (latest)`);
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
    expect(out).not.toContain('claude-nomad: 0.11.2');
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
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toContain('ahead of latest release');
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
    expect(out).toContain(`${warnGlyph} claude-nomad: 0.11.2 -> 0.11.3`);
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
    expect(out).not.toContain(`${okGlyph} version`);
    expect(out).not.toContain(`${warnGlyph} version`);
    expect(out).not.toMatch(/claude-nomad: \d/);
    expect(process.exitCode === 1).toBe(false);
  });
});
