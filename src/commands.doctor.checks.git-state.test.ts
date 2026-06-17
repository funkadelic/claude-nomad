import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, warnGlyph } from './color.ts';
import {
  type Env,
  joinedLog,
  makeDoctorEnv,
  restoreEnv,
} from './commands.doctor.checks.test-helpers.ts';

// ---------------------------------------------------------------------------
// Real-git helpers for unmerged-index and autostash fixtures
// ---------------------------------------------------------------------------

/** Create a commit in `repo`. */
function makeDocCommit(repo: string, file: string, content: string, msg: string): void {
  writeFileSync(join(repo, file), content);
  execFileSync('git', ['add', file], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
}

/**
 * Mutate an existing git repo at `dir` to have unmerged stage-2/3 entries
 * and no active rebase/merge marker (torn-down-rebase fixture).
 */
function addUnmergedIndex(dir: string): void {
  makeDocCommit(dir, 'f.txt', 'base\n', 'base');
  execFileSync('git', ['checkout', '-q', '-b', 'br'], { cwd: dir });
  makeDocCommit(dir, 'f.txt', 'branch-val\n', 'branch');
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  makeDocCommit(dir, 'f.txt', 'main-val\n', 'main');
  try {
    execFileSync('git', ['merge', '--no-commit', 'br'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Expected conflict.
  }
  for (const marker of ['MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG']) {
    try {
      unlinkSync(join(dir, '.git', marker));
    } catch {
      // May not exist.
    }
  }
}

/**
 * Push an entry whose subject contains "autostash" onto the stash list in
 * `dir`. Simulates the orphaned autostash left by a torn-down rebase.
 */
function addOrphanedAutostash(dir: string): void {
  // Write a file that won't be committed; stash it with a custom message.
  writeFileSync(join(dir, 'stashed.txt'), 'dirty\n');
  execFileSync('git', ['add', 'stashed.txt'], { cwd: dir });
  execFileSync('git', ['stash', 'push', '-m', 'autostash'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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

  it('is silent in the Repository section when gitleaks IS on PATH', async () => {
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
    // Silent on success: the Repository probe adds no row (the Dependency
    // Versions drift check owns the visible gitleaks line) and never warns
    // or fails when the binary runs.
    expect(out).not.toContain(`${failGlyph} gitleaks`);
    expect(out).not.toContain('gitleaks: not on PATH');
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
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
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
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
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
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
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

describe('reportRebaseClean', () => {
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

  it('emits a WARN line when the repo has uncommitted changes', async () => {
    // Commit what the scaffold wrote (settings.base.json etc) so the repo
    // starts clean, then stage a new file to produce dirty status.
    const repoDir = join(env.testHome, 'claude-nomad');
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=T', 'commit', '-m', 'init'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(join(repoDir, 'uncommitted.txt'), 'dirty\n');
    execFileSync('git', ['add', 'uncommitted.txt'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { reportRebaseClean } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseClean(sec);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(warnGlyph);
    expect(out).toContain('uncommitted changes');
    // WARN must not set exitCode -- this is informational only.
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing when the repo is clean', async () => {
    // Commit the scaffold files so git status returns empty (clean tree).
    const repoDir = join(env.testHome, 'claude-nomad');
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=T', 'commit', '-m', 'init'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { reportRebaseClean } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseClean(sec);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).not.toContain('uncommitted changes');
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reportRebaseState: unmerged-index extension (Phase 51 D-5)
// ---------------------------------------------------------------------------

describe('reportRebaseState unmerged-index FAIL', () => {
  let tmp: string;
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
    // Create a real git repo that ALSO serves as REPO_HOME (testHome/claude-nomad).
    env = makeDoctorEnv({ host: 'test-host', setupGitRepo: true });
    tmp = join(env.testHome, 'claude-nomad');
    // makeDoctorEnv git init does not set user identity; configure it for commits.
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits a FAIL line and sets exitCode=1 on an unmerged-index repo', async () => {
    // Build the unmerged-index-no-marker fixture inside the REPO_HOME repo.
    addUnmergedIndex(tmp);
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(1);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toMatch(/unmerged index/);
    expect(out).toMatch(/nomad pull --force-remote/);
  });

  it('preserves the existing mid-rebase FAIL on a mid-rebase repo', async () => {
    makeDocCommit(tmp, 'a.ts', 'x\n', 'init');
    mkdirSync(join(tmp, '.git', 'rebase-merge'));
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(1);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toMatch(/mid-rebase/);
  });

  it('emits nothing and leaves exitCode=0 on a clean committed repo (no new FAIL)', async () => {
    // Clean repo: no marker, no unmerged index.
    makeDocCommit(tmp, 'a.ts', 'x\n', 'init');
    const { reportRebaseState } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    expect(process.exitCode).toBe(0);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/unmerged index|mid-rebase|mid-merge/);
  });
});

// ---------------------------------------------------------------------------
// reportOrphanedAutostash: new WARN reporter (Phase 51 D-5)
// ---------------------------------------------------------------------------

describe('reportOrphanedAutostash WARN', () => {
  let tmp: string;
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
    tmp = join(env.testHome, 'claude-nomad');
    // Set user identity and make an initial commit (git stash requires a commit).
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    makeDocCommit(tmp, 'a.ts', 'initial\n', 'init');
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('NOMAD_HOST', originalNomadHost);
    restoreEnv('NO_COLOR', originalNoColor);
    rmSync(env.testHome, { recursive: true, force: true });
  });

  it('emits a WARN line when an orphaned autostash is present and does NOT set exitCode', async () => {
    addOrphanedAutostash(tmp);
    const { reportOrphanedAutostash } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportOrphanedAutostash(sec);
    // WARN must NOT set exitCode (non-blocking per D-5).
    expect(process.exitCode).toBe(0);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(warnGlyph);
    expect(out).toMatch(/autostash/);
    // Must include the runbook hint.
    expect(out).toMatch(/git stash/);
  });

  it('emits nothing and leaves exitCode=0 on a clean repo (no autostash entry)', async () => {
    // No stash entries at all.
    const { reportOrphanedAutostash } = await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportOrphanedAutostash(sec);
    expect(process.exitCode).toBe(0);
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).not.toMatch(/autostash/);
  });

  it('emits both FAIL (unmerged-index) and WARN (autostash) independently in the same run', async () => {
    // Stash must be added BEFORE the unmerged index (unmerged index blocks git stash push).
    addOrphanedAutostash(tmp);
    // Now build the unmerged-index state.
    addUnmergedIndex(tmp);
    const { reportRebaseState, reportOrphanedAutostash } =
      await import('./commands.doctor.checks.git-state.ts');
    const { section, renderDoctor } = await import('./commands.doctor.format.ts');
    const sec = section('Repository');
    reportRebaseState(sec);
    reportOrphanedAutostash(sec);
    expect(process.exitCode).toBe(1); // FAIL from unmerged-index
    renderDoctor([sec]);
    const out = joinedLog(env.logSpy);
    expect(out).toContain(failGlyph);
    expect(out).toContain(warnGlyph);
    expect(out).toMatch(/unmerged index/);
    expect(out).toMatch(/autostash/);
  });

  it('wires reportOrphanedAutostash into cmdDoctor output (WARN emitted from a full doctor run)', async () => {
    // Integration: prove the reporter is imported and called in cmdDoctor.
    // Write path-map.json so reportPathMap does not set exitCode independently.
    writeFileSync(
      join(env.testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: {} }) + '\n',
    );
    addOrphanedAutostash(tmp);
    const { cmdDoctor } = await import('./commands.doctor.ts');
    cmdDoctor();
    const out = joinedLog(env.logSpy);
    expect(out).toContain(warnGlyph);
    expect(out).toMatch(/autostash/);
    // exitCode must remain 0 (autostash is non-blocking).
    expect(process.exitCode).toBe(0);
  });
});
