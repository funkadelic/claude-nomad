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

describe('cmdDoctor PASS-token info lines and section headers', () => {
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

  it('does not prefix purely informational lines with the PASS glyph', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // Purely-info lines (host, mapped projects, never-sync items, remote
    // origin) wear the dim info marker, never a PASS glyph. The repo/claude
    // home/host-overrides lines DO carry status now (presence/parse-success
    // is conveyed via the gutter glyph), so they are intentionally absent
    // from this list.
    expect(out).not.toContain(`${okGlyph} NOMAD_HOST:`);
    expect(out).not.toContain(`${okGlyph} Mapped projects for`);
    expect(out).not.toContain(`${okGlyph} never-sync items:`);
    expect(out).not.toContain(`${okGlyph} remote origin:`);
  });

  it('labels the host line NOMAD_HOST with no unset hint or NOMAD_REPO echo when only NOMAD_HOST is set', async () => {
    populateHealthy();
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain('NOMAD_HOST: test-host');
    expect(out).not.toContain('(env unset, using hostname)');
    // NOMAD_REPO is not set in this sandbox, so no echo line appears.
    expect(out).not.toContain('NOMAD_REPO:');
  });

  it('hints when NOMAD_HOST is unset and echoes NOMAD_REPO when the user has set it', async () => {
    populateHealthy();
    mockGitleaksPresent();
    delete process.env.NOMAD_HOST;
    const prevRepo = process.env.NOMAD_REPO;
    const repoPath = join(env.testHome, 'claude-nomad');
    process.env.NOMAD_REPO = repoPath;
    // config.ts reads both env vars at module init; re-evaluate it.
    vi.resetModules();
    try {
      const { cmdDoctor } = await import('./commands.doctor.ts');
      cmdDoctor();
      const out = joinedLog(env.logSpy);
      expect(out).toContain('(env unset, using hostname)');
      expect(out).toContain(`NOMAD_REPO: ${repoPath}`);
    } finally {
      restoreEnv('NOMAD_REPO', prevRepo);
    }
  });

  it('annotates absent repo and claude-home paths with the WARN glyph (informational, no exitCode mutation)', async () => {
    // The healthy-host setup is already in place via makeDoctorEnv. Tear down
    // both REPO_HOME (~/claude-nomad) and CLAUDE_HOME (~/.claude) to exercise
    // the falsy branches of the existsSync ternaries inside reportHostAndPaths.
    // The authoritative empty-repo FAIL (exitCode=1) is reported by
    // reportRepoState, not by these existsSync lines; those carry only
    // a warnGlyph cue so sectionFailed does not flip the Host header.
    rmSync(join(env.testHome, 'claude-nomad'), { recursive: true, force: true });
    rmSync(join(env.testHome, '.claude'), { recursive: true, force: true });
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(`${warnGlyph} repo:`);
    expect(out).toContain(`${warnGlyph} claude home:`);
  });

  it('does NOT decorate the Host section header with ✘ when only CLAUDE_HOME is absent', async () => {
    // Regression guard: a missing ~/.claude/ is informational. reportRepoState
    // owns the empty-repo FAIL via process.exitCode; reportHostAndPaths must
    // use warnGlyph (not failGlyph) so sectionFailed stays calm and the Host
    // header renders without the red `✘ ` prefix despite the missing dir.
    // populateHealthy() removes CLAUDE.md's symlink target's parent dir later;
    // we run it first to get an otherwise-healthy host, then drop ~/.claude/.
    populateHealthy();
    rmSync(join(env.testHome, '.claude'), { recursive: true, force: true });
    mockGitleaksPresent();
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    // The claude-home line carries the WARN glyph...
    expect(out).toContain(`${warnGlyph} claude home:`);
    // ...and the Host section header is NOT prefixed with the failed-section glyph.
    expect(out).toMatch(/^Host$/m);
    expect(out).not.toMatch(/✘ Host/);
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
