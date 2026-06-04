import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

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
    expect(out).not.toContain(`${failGlyph} gitleaks`);
    expect(out).toContain('never-sync items:');
  });

  it('logs WARN (not FAIL) and does NOT set exitCode when gitleaks is absent (ENOENT)', async () => {
    // gitleaks is an optional dependency: its absence must degrade to WARN so
    // `nomad doctor` exits 0 in environments (e.g. the npm-publish runner) that
    // have not installed it. Only `nomad push` hard-requires gitleaks.
    // Populate path-map.json so the Path-map check does not set exitCode
    // independently of the probe under test.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
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
    expect(out).toContain(warnGlyph);
    expect(out).toContain('gitleaks');
    expect(out).toContain('not on PATH');
    expect(out).not.toContain(`${failGlyph} gitleaks`);
    expect(out).toContain('never-sync items:');
    expect(process.exitCode).toBe(0);
  });

  it('logs FAIL and sets exitCode=1 when gitleaks errors with non-ENOENT', async () => {
    // A present-but-unrunnable binary is a real defect (broken install); FAIL
    // and exitCode=1 are correct here, unlike the absent-gitleaks ENOENT case.
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
    expect(out).toContain(failGlyph);
    expect(out).toContain('gitleaks');
    expect(out).toContain('probe failed');
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

describe('reportRebaseState', () => {
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
    // setupGitRepo: true so a real .git scaffold is present; we add or omit
    // marker dirs/files to simulate wedged vs clean state.
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

  it('emits a FAIL line and sets exitCode=1 on a mid-rebase repo', async () => {
    // Create .git/rebase-merge to simulate a wedged rebase state.
    mkdirSync(join(env.testHome, 'claude-nomad', '.git', 'rebase-merge'));
    const { reportRebaseState } = await import('./commands.doctor.checks.repository.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(1);
    // The FAIL line must appear in the section items. Access the items via
    // cmdDoctor output to avoid coupling to format internals.
    const { renderDoctor } = await import('./commands.doctor.format.ts');
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toMatch(/mid-rebase/);
    expect(out).toMatch(/--force-remote/);
  });

  it('emits a FAIL line and sets exitCode=1 on a mid-merge repo', async () => {
    // Create .git/MERGE_HEAD to simulate a wedged merge state.
    writeFileSync(join(env.testHome, 'claude-nomad', '.git', 'MERGE_HEAD'), 'deadbeef\n');
    const { reportRebaseState } = await import('./commands.doctor.checks.repository.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(1);
    const { renderDoctor } = await import('./commands.doctor.format.ts');
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toMatch(/mid-merge/);
    expect(out).toMatch(/--force-remote/);
  });

  it('emits nothing and leaves exitCode=0 on a clean repo', async () => {
    // No marker files: clean repo.
    const { reportRebaseState } = await import('./commands.doctor.checks.repository.ts');
    const { section } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(0);
    const { renderDoctor } = await import('./commands.doctor.format.ts');
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    // No FAIL line referencing rebase state.
    expect(out).not.toMatch(/mid-rebase|mid-merge/);
  });

  it('wires reportRebaseState into cmdDoctor output (FAIL + exitCode=1 on wedged repo)', async () => {
    // Integration: verify the reporter is wired into cmdDoctor so the full
    // doctor output surfaces the wedge FAIL.
    mkdirSync(join(env.testHome, 'claude-nomad', '.git', 'rebase-merge'));
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toMatch(/mid-rebase/);
    expect(process.exitCode).toBe(1);
  });
});
