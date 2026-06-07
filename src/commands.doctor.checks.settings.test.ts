import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

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
    // Reset BEFORE spy restore so a leaked process.exitCode = 1 from cmdDoctor()
    // does not bleed into later tests.
    process.exitCode = 0;
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
    expect(out).not.toContain(`${warnGlyph} settings.json has unknown keys`);
  });

  it('emits WARN listing the drift key when settings.json contains an unknown key', async () => {
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', newAnthropicFeature: true }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} settings.json has unknown keys`);
    expect(out).toContain('newAnthropicFeature');
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
    expect(out).not.toContain(`${failGlyph} no hosts/`);
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
    expect(out).toContain(
      `${failGlyph} no hosts/nonexistent-host.json AND settings.json has unbased keys`,
    );
    expect(out).toContain('statusLine');
    expect(out).toMatch(/candidates:/);
    expect(out).toContain('dell-wsl.json');
    expect(out).toContain('norm-mbp.json');
    expect(process.exitCode).toBe(1);
  });

  it('FAILs without a candidates line when hostFile missing, settings drift, AND hosts/ dir absent', async () => {
    process.env.NOMAD_HOST = 'nonexistent-host';
    // Remove the hosts/ dir so existsSync(hostsDir) takes its false path: the
    // drift FAIL still fires, but no candidates line is emitted.
    rmSync(join(env.testHome, 'claude-nomad', 'hosts'), { recursive: true, force: true });
    writeFileSync(
      join(env.testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command' } }) + '\n',
    );
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      `${failGlyph} no hosts/nonexistent-host.json AND settings.json has unbased keys`,
    );
    expect(out).not.toMatch(/candidates:/);
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
    expect(out).not.toContain(`${failGlyph} no hosts/`);
  });
});

describe('loadBaseSettings unit tests', () => {
  // Direct unit tests for loadBaseSettings that exercise the existsSync guard
  // (L29) and the FAIL path without going through the full cmdDoctor stack.
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-settings-unit-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns null and records a FAIL item when shared/settings.base.json is absent', async () => {
    // Kills the L29 ConditionalExpression mutation: `if (!existsSync(basePath))`
    // mutated to `if (false)` would skip the missing-file guard and attempt
    // readJsonSafe on a non-existent path, silently returning null without the
    // FAIL item. The test asserts the FAIL item IS recorded.
    const { section } = await import('./commands.doctor.format.ts');
    const { loadBaseSettings } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    const result = loadBaseSettings(sec);
    expect(result).toBeNull();
    const out = sec.items.join('\n');
    expect(out).toContain(failGlyph);
    expect(out).toContain('settings.base.json missing');
    expect(process.exitCode).toBe(1);
  });
});

describe('loadAndReportSettings unit tests', () => {
  // Direct unit tests for loadAndReportSettings.
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-settings-unit-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns null silently (no throw) when settings.json is malformed JSON', async () => {
    // Kills the L42 ConditionalExpression mutation: `if (settings === null)
    // return null` mutated to `if (false) return null` would skip the null guard
    // and proceed to Object.keys(null), throwing a TypeError. The test asserts
    // no throw and a null return.
    const claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), 'not-valid-json\n');
    const { section } = await import('./commands.doctor.format.ts');
    const { loadAndReportSettings } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    expect(() => {
      const result = loadAndReportSettings(sec);
      expect(result).toBeNull();
    }).not.toThrow();
    // The readJsonSafe call records a FAIL item for the malformed JSON.
    expect(sec.items.join('\n')).toContain(failGlyph);
  });

  it('returns settings and emits an okGlyph row when settings.json has only known keys', async () => {
    // Verifies the happy path: known-keys-only settings emits an OK schema row
    // and returns the parsed object. Pins the L64 ConditionalExpression survivors.
    const claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }) + '\n');
    const { section } = await import('./commands.doctor.format.ts');
    const { loadAndReportSettings } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    const result = loadAndReportSettings(sec);
    expect(result).not.toBeNull();
    expect(sec.items.join('\n')).toContain(okGlyph);
    expect(sec.items.join('\n')).toContain('known keys only');
  });
});

describe('reportHostOverrides unit tests', () => {
  // Direct unit tests for the drift calculation and candidate-list logic.
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-hostoverride-unit-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    process.env.NOMAD_REPO = join(testHome, 'claude-nomad');
    mkdirSync(join(testHome, 'claude-nomad', 'hosts'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NOMAD_REPO', originalNomadRepo);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits a base-only OK line when base and settings are both null (no drift to compute)', async () => {
    // Kills the L63-L64 `base !== null && settings !== null` mutation: with
    // `base !== null || settings !== null` a null base would still trigger drift
    // computation on settings alone, producing false-positive drift. With both
    // null (no base, no settings), the drift array stays empty and the base-only
    // OK path fires.
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostOverrides } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    reportHostOverrides(sec, null, null);
    const out = sec.items.join('\n');
    expect(out).toContain(`${okGlyph} host overrides: none (base-only is fine, no settings drift)`);
    expect(out).not.toContain(failGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('emits base-only OK when hostFile is absent and settings has NO drift', async () => {
    // Pins the base-only branch: no hostFile, no drift -> OK not FAIL.
    // Kills the L63 ArrayDeclaration mutation (drift starts as ["Stryker was here"]).
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostOverrides } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    // base has `model`, settings also has `model` -> no drift.
    reportHostOverrides(sec, { model: 'sonnet' }, { model: 'sonnet' });
    const out = sec.items.join('\n');
    expect(out).toContain(`${okGlyph} host overrides: none (base-only is fine, no settings drift)`);
    expect(out).not.toContain(failGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('emits FAIL with drift key when settings has an unbased key and hostFile is absent', async () => {
    // Kills the L64 LogicalOperator mutation: `base !== null || settings !== null`
    // would skip drift calculation when base is null (only one condition needed).
    // With correct AND semantics, drift is only computed when BOTH are non-null.
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostOverrides } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    reportHostOverrides(sec, { model: 'sonnet' }, { model: 'sonnet', statusLine: {} });
    const out = sec.items.join('\n');
    expect(out).toContain(failGlyph);
    expect(out).toContain('unbased keys');
    expect(out).toContain('statusLine');
    expect(process.exitCode).toBe(1);
  });

  it('emits a candidates line when hostsDir has .json files', async () => {
    // Kills the L79-L80 candidates-list path: with `cands.length >= 0` mutation
    // (always true) the check is no-op; with `cands.length > 0` (correct) an
    // empty hosts/ dir produces no candidates line. This test has real .json
    // files and asserts the candidates line appears.
    const hostsDir = join(testHome, 'claude-nomad', 'hosts');
    mkdirSync(hostsDir, { recursive: true });
    writeFileSync(join(hostsDir, 'other-host.json'), '{}\n');
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostOverrides } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    reportHostOverrides(sec, { model: 'sonnet' }, { model: 'sonnet', statusLine: {} });
    const out = sec.items.join('\n');
    expect(out).toContain('candidates:');
    expect(out).toContain('other-host.json');
  });

  it('does NOT emit a candidates line when hostsDir has no .json files', async () => {
    // Kills the L80 EqualityOperator mutation: `cands.length >= 0` would always
    // emit the candidates line even with an empty list. With correct `> 0`, an
    // empty hostsDir yields no candidates line.
    const { section } = await import('./commands.doctor.format.ts');
    const { reportHostOverrides } = await import('./commands.doctor.checks.settings.ts');
    const sec = section('Settings');
    reportHostOverrides(sec, { model: 'sonnet' }, { model: 'sonnet', statusLine: {} });
    const out = sec.items.join('\n');
    expect(out).not.toContain('candidates:');
  });
});
