import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  mockGitleaksPresent,
  restoreEnv,
} from './checks/test-helpers.ts';
import { stubPlatform } from '../../test-helpers.platform.ts';

describe('cmdDoctor --check-shared dispatch wiring', () => {
  // Dispatch-level wiring only: plain doctor must NOT scan, the flag
  // must append a "Shared scan" section. The deep check-shared behavior lives
  // in commands.doctor.check-shared.test.ts (plan 01) under a real-binary
  // gate; here we drive a zero-staged path-map so the reporter short-circuits
  // to a clean ok row without invoking the real gitleaks binary, and mock the
  // gitleaks probe present so the reporter does not WARN-skip on dev hosts.
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
    // Empty path-map so buildScanTree stages 0 sessions and reportCheckShared
    // short-circuits to a clean ok row (no real gitleaks invocation).
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    mockGitleaksPresent();
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

  it('does NOT emit a Shared scan section for plain cmdDoctor()', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Shared scan');
  });

  it('emits a Shared scan section when cmdDoctor({ checkShared: true })', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ checkShared: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Shared scan');
  });

  it('does NOT emit a Schema scan section for plain cmdDoctor()', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Schema scan');
  });

  it('emits a Schema scan section when cmdDoctor({ checkSchema: true })', async () => {
    // No ~/.claude/settings.json in the sandbox, so reportCheckSchema short
    // -circuits to its info row before any network fetch; this still exercises
    // the dispatch wiring (the section renders only when the flag is set).
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ checkSchema: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Schema scan');
  });

  it('emits a Remote check section when cmdDoctor({ checkRemote: true })', async () => {
    // No origin/main is cached in the sandbox, so reportCheckRemote degrades to
    // a skip row before any network access; this still exercises the dispatch
    // wiring (the section renders only when the flag is set).
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ checkRemote: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Remote check');
  });
});

describe('cmdDoctor compact default vs --verbose', () => {
  // End-to-end lock on the render-time filter: the all-passing Repository
  // section is hidden by default but present under verbose, while the Summary
  // verdict always renders. A git repo with local identity is required so
  // reportGitIdentity emits a PASS row (stripped in compact) rather than a
  // WARN row (kept in compact, which would make the section visible).
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
    const repoDir = join(env.testHome, 'claude-nomad');
    // Set local git identity so reportGitIdentity emits a PASS row (stripped
    // in compact mode), not a WARN row (which would keep the section visible).
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Write path-map.json before committing so the tree is clean and
    // reportRebaseClean does not WARN (which would keep Repository visible).
    writeFileSync(join(repoDir, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    // Commit all initial files so git status returns a clean tree.
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-q', '-m', 'init'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mockGitleaksPresent();
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

  it('hides an all-passing section but keeps the Summary verdict by default', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('Repository');
    expect(out).toContain('Summary');
  });

  it('shows the full per-check tree under --verbose', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('Repository');
    expect(out).toContain('Summary');
  });
});

describe('cmdDoctor sync modality + long-paths rows', () => {
  // process.platform stub so the Environment section's win32-only long-paths
  // rows and the cross-platform sync-modality row can be driven end-to-end
  // without a real Windows host.
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let env: Env;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    env = makeDoctorEnv({ host: 'test-host' });
    mockGitleaksPresent();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    process.exitCode = 0;
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('includes the copy-sync modality row and the long-paths rows on a win32 stub', async () => {
    stubPlatform('win32');
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('copy-sync');
    expect(out).toContain('core.longpaths');
    expect(out).toContain('OS long paths');
  });

  it('includes the symlink modality row and excludes long-paths rows on a posix stub', async () => {
    stubPlatform('darwin');
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('symlink');
    expect(out).not.toContain('core.longpaths');
    expect(out).not.toContain('OS long paths');
  });
});

describe('cmdDoctor CRLF guard row', () => {
  // The sandbox REPO_HOME has no .gitattributes and is not a git repo, so the
  // check WARNs (guard absent, config probe throws -> latent risk). WARN rows
  // are kept in compact mode, so no --verbose flag is needed to see it.
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
    mockGitleaksPresent();
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

  it('includes the CRLF guard row in the Environment section', async () => {
    const { cmdDoctor } = await import('./doctor.ts');
    cmdDoctor({ verbose: true });
    const out = joinedLog(env.logSpy);
    expect(out).toContain('CRLF guard');
  });
});
