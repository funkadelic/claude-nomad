import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  mockGitleaksPresent,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} shared/settings.base.json missing`);
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL invalid schema and continues when path-map.json parses to a non-object projects field', async () => {
    // path-map.json is valid JSON but schema-invalid. Without the projects
    // guard, Object.entries(map.projects) throws and aborts doctor output
    // mid-stream, violating the tolerant-doctor contract.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when projects field is an array instead of an object', async () => {
    // Arrays are typeof === 'object', so a bare `typeof !== 'object'` check
    // misses them. Without the Array.isArray guard, the helpers would iterate
    // a non-map shape and emit garbage rows.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{"projects":[]}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json invalid schema`);
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when a project entry maps to null instead of a hosts object', async () => {
    // Per-project guard: `hosts[HOST]` and `Object.values(hosts)` would throw
    // if `hosts` is null. Without the per-entry validation, helpers crash
    // mid-output and break the tolerant-doctor contract.
    writeFileSync(join(env.testHome, 'claude-nomad', 'path-map.json'), '{"projects":{"foo":null}}');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      `${failGlyph} path-map.json invalid schema: project "foo" hosts must be an object`,
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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      `${failGlyph} path-map.json invalid schema: project "foo" hosts must be an object`,
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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(
      `${failGlyph} path-map.json invalid schema: project "foo" host "test-host" path must be a string`,
    );
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL and sets exitCode=1 when path-map.json is missing', async () => {
    // makeDoctorEnv does not write path-map.json by default; assert the
    // missing-file FAIL path so doctor matches cmdPush's hard-stop behavior.
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${failGlyph} path-map.json missing`);
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
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toContain('malformed JSON');
    expect(out).toContain('settings.base.json');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });

  it('reports FAIL when hosts/<HOST>.json is malformed', async () => {
    // Write a garbage host file. Pre-fix, doctor never parsed it; pull's
    // deep-merge would be the first place the malformed JSON surfaced.
    writeFileSync(join(env.testHome, 'claude-nomad', 'hosts', 'test-host.json'), '{ not valid');
    const { cmdDoctor } = await import('./commands.doctor.ts');
    expect(() => cmdDoctor({ verbose: true })).not.toThrow();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toContain('malformed JSON');
    expect(out).toContain('test-host.json');
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(1);
  });
});
