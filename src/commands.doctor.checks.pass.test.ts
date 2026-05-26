import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  mockGitleaksPresent,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

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
    const passCount = out.split(okGlyph).length - 1;
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
    expect(out).toContain(`${okGlyph} settings.json schema: known keys only`);
  });

  it('emits PASS path-encoding when no encoded-dir collisions exist', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} path-encoding: no collisions`);
  });

  it('prepends PASS to the gitleaks version line when gitleaks is present', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} gitleaks:`);
    expect(out).toMatch(/v\d+\.\d+/);
  });

  it('emits PASS gitlink scan when shared/ contains no nested .git entries', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${okGlyph} gitlink scan:`);
  });

  it('replaces "symlink OK" with "PASS symlink" on a valid SHARED_LINKS entry', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Positive: PASS-prefixed phrasing for the symlink success branch
    // (e.g., `${okGlyph} CLAUDE.md: symlink`).
    expect(out).toContain(`${okGlyph} CLAUDE.md: symlink`);
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
    expect(out).toContain(`${warnGlyph} CLAUDE.md: missing`);
  });
});
