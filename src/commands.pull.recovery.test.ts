import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/** vi.spyOn(console, 'log') return type shorthand. */
type LogSpy = MockInstance<(...args: unknown[]) => void>;

import { classifyTouched, gitCapture, recoverForceRemote } from './commands.pull.recovery.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a real git repo at `dir` with user identity configured.
 */
function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
}

/**
 * Create a commit in `repo` with `content` written to `file`.
 */
function makeCommit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  execFileSync('git', ['add', file], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo });
}

/**
 * Build a fixture where local and remote both modify the SAME file, forcing
 * a rebase conflict. The local repo is left in a wedged mid-rebase state.
 *
 * Returns { origin, local } absolute paths.
 */
function buildConflictingWedgedRebase(tmp: string): { origin: string; local: string } {
  const origin = join(tmp, 'origin.git');
  const local = join(tmp, 'local');
  mkdirSync(origin, { recursive: true });

  // Init bare origin with base commit (shared.ts = 'v1').
  execFileSync('git', ['init', '-q', '-b', 'main', '--bare'], { cwd: origin });
  const seed = join(tmp, 'seed');
  mkdirSync(seed, { recursive: true });
  initRepo(seed);
  writeFileSync(join(seed, 'shared.ts'), 'v1\n');
  execFileSync('git', ['add', 'shared.ts'], { cwd: seed });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  // Clone local from origin.
  execFileSync('git', ['clone', '-q', origin, local]);
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: local });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: local });

  // Advance origin: another clone pushes a change to shared.ts.
  const other = join(tmp, 'other');
  execFileSync('git', ['clone', '-q', origin, other]);
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
  makeCommit(other, 'shared.ts', 'remote-value\n', 'remote commit');
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

  // Local adds a conflicting change to shared.ts (tool-source file).
  makeCommit(local, 'shared.ts', 'local-value\n', 'local commit');

  // Fetch origin to update origin/main ref in local, then rebase (will conflict).
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: local });
  try {
    execFileSync('git', ['rebase', 'origin/main'], {
      cwd: local,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Expected conflict: repo is now wedged mid-rebase.
  }

  return { origin, local };
}

// ---------------------------------------------------------------------------
// classifyTouched - synced-config classification (isSyncedConfig via public API)
// ---------------------------------------------------------------------------

describe('classifyTouched - synced-config classification', () => {
  it('exact entry: path-map.json is synced', () => {
    const { synced } = classifyTouched(['path-map.json']);
    expect(synced).toContain('path-map.json');
  });

  it('prefix entry: shared/agents/x.md is synced (matches shared/agents/ prefix)', () => {
    const { synced } = classifyTouched(['shared/agents/x.md']);
    expect(synced).toContain('shared/agents/x.md');
  });

  it('prefix lookalike: shared-evil/x does NOT match (no false prefix hit)', () => {
    const { synced, toolSource } = classifyTouched(['shared-evil/x']);
    expect(synced).toHaveLength(0);
    expect(toolSource).toContain('shared-evil/x');
  });

  it('tool source file is not synced', () => {
    const { synced, toolSource } = classifyTouched(['src/tool.ts']);
    expect(synced).toHaveLength(0);
    expect(toolSource).toContain('src/tool.ts');
  });

  it('hosts/ prefix entry: hosts/myhost.json is synced', () => {
    const { synced } = classifyTouched(['hosts/myhost.json']);
    expect(synced).toContain('hosts/myhost.json');
  });

  it('shared/settings.base.json is synced (exact entry)', () => {
    const { synced } = classifyTouched(['shared/settings.base.json']);
    expect(synced).toContain('shared/settings.base.json');
  });

  it('mixed list: partitions correctly', () => {
    const { synced, toolSource } = classifyTouched([
      'src/foo.ts',
      'path-map.json',
      'shared/rules/x.md',
    ]);
    expect(synced).toEqual(expect.arrayContaining(['path-map.json', 'shared/rules/x.md']));
    expect(toolSource).toEqual(['src/foo.ts']);
  });

  it('empty list returns empty arrays', () => {
    const { synced, toolSource } = classifyTouched([]);
    expect(synced).toHaveLength(0);
    expect(toolSource).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// gitCapture
// ---------------------------------------------------------------------------

describe('gitCapture', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-gitcapture-'));
    initRepo(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns trimmed stdout for a git command', () => {
    makeCommit(tmp, 'a.ts', 'x', 'first');
    const out = gitCapture(['log', '--oneline'], tmp);
    expect(out).toMatch(/first/);
    expect(out).not.toMatch(/^\n/);
    expect(out).not.toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// recoverForceRemote - tool-source-only recovery (rebase mode)
// ---------------------------------------------------------------------------

describe('recoverForceRemote - tool-source-only stranded commits', () => {
  let tmp: string;
  let logSpy: LogSpy;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-clean-'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('aborts rebase, parks stranded commit, HEAD ends at origin/main', () => {
    const { local } = buildConflictingWedgedRebase(tmp);

    // Confirm the repo is actually wedged before calling recovery.
    const gitDir = join(local, '.git');
    const isWedged =
      existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
    expect(isWedged).toBe(true);

    recoverForceRemote('rebase', local);

    // HEAD should now equal origin/main.
    const head = gitCapture(['rev-parse', 'HEAD'], local);
    const originMain = gitCapture(['rev-parse', 'origin/main'], local);
    expect(head).toBe(originMain);
  });

  it('parking branch contains the stranded commit', () => {
    const { local } = buildConflictingWedgedRebase(tmp);

    recoverForceRemote('rebase', local);

    // A nomad/stranded-* branch must exist.
    const branches = gitCapture(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim().length).toBeGreaterThan(0);

    // The parking branch log must include the stranded commit.
    const branchName = branches.trim().replace(/^\*?\s+/, '');
    const log = gitCapture(['log', '--oneline', `origin/main..${branchName}`], local);
    expect(log.trim().length).toBeGreaterThan(0);
    expect(log).toMatch(/local commit/);
  });

  it('logs a summary mentioning the parking branch name', () => {
    const { local } = buildConflictingWedgedRebase(tmp);

    recoverForceRemote('rebase', local);

    const logOutput = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logOutput).toMatch(/nomad\/stranded-/);
  });
});

// ---------------------------------------------------------------------------
// recoverForceRemote - merge mode
// ---------------------------------------------------------------------------

describe('recoverForceRemote - merge mode', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-merge-'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('aborts a mid-merge state and resets HEAD to origin/main', () => {
    const origin = join(tmp, 'origin.git');
    const local = join(tmp, 'local');
    mkdirSync(origin, { recursive: true });

    // Init bare origin.
    execFileSync('git', ['init', '-q', '-b', 'main', '--bare'], { cwd: origin });
    const seed = join(tmp, 'seed');
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    writeFileSync(join(seed, 'shared.ts'), 'v1\n');
    execFileSync('git', ['add', 'shared.ts'], { cwd: seed });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: seed });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

    // Clone.
    execFileSync('git', ['clone', '-q', origin, local]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: local });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: local });

    // Advance origin.
    const other = join(tmp, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
    makeCommit(other, 'shared.ts', 'remote\n', 'remote commit');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

    // Local also changes shared.ts (will conflict on merge).
    makeCommit(local, 'shared.ts', 'local-merge\n', 'local merge commit');

    // Fetch and attempt a conflicting merge.
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: local });
    try {
      execFileSync('git', ['merge', 'origin/main'], {
        cwd: local,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Expected conflict.
    }

    // Confirm MERGE_HEAD exists (wedged mid-merge).
    expect(existsSync(join(local, '.git', 'MERGE_HEAD'))).toBe(true);

    recoverForceRemote('merge', local);

    const head = gitCapture(['rev-parse', 'HEAD'], local);
    const originMain = gitCapture(['rev-parse', 'origin/main'], local);
    expect(head).toBe(originMain);
  });
});

// ---------------------------------------------------------------------------
// recoverForceRemote - synced-config refusal on committed paths
// ---------------------------------------------------------------------------

describe('recoverForceRemote - synced-config refusal (committed paths)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-refuse-'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses when stranded commit touches path-map.json, lists the path', async () => {
    const origin = join(tmp, 'origin.git');
    const local = join(tmp, 'local');
    mkdirSync(origin, { recursive: true });

    execFileSync('git', ['init', '-q', '-b', 'main', '--bare'], { cwd: origin });
    const seed = join(tmp, 'seed');
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    writeFileSync(join(seed, 'base.ts'), 'v1\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: seed });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: seed });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

    execFileSync('git', ['clone', '-q', origin, local]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: local });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: local });

    // Advance origin: changes base.ts to trigger conflict.
    const other = join(tmp, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
    makeCommit(other, 'base.ts', 'remote-base\n', 'remote base change');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

    // Local stranded commits: one tool-source file + one synced-config file.
    makeCommit(local, 'tool.ts', 'tool\n', 'tool commit');
    makeCommit(local, 'path-map.json', '{"projects":{}}\n', 'path-map config commit');
    // Also change base.ts to cause the rebase conflict.
    makeCommit(local, 'base.ts', 'local-base\n', 'local base change');

    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: local });
    try {
      execFileSync('git', ['rebase', 'origin/main'], {
        cwd: local,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* expected conflict */
    }

    const { NomadFatal } = await import('./utils.ts');
    let thrown: unknown;
    try {
      recoverForceRemote('rebase', local);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NomadFatal);
    expect((thrown as Error).message).toMatch(/path-map\.json/);
  });

  it('no parking branch created after refusal', async () => {
    const origin = join(tmp, 'origin2.git');
    const local = join(tmp, 'local2');
    mkdirSync(origin, { recursive: true });

    execFileSync('git', ['init', '-q', '-b', 'main', '--bare'], { cwd: origin });
    const seed = join(tmp, 'seed2');
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    writeFileSync(join(seed, 'shared.ts'), 'v1\n');
    execFileSync('git', ['add', 'shared.ts'], { cwd: seed });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: seed });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

    execFileSync('git', ['clone', '-q', origin, local]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: local });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: local });

    const other = join(tmp, 'other2');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
    makeCommit(other, 'shared.ts', 'remote\n', 'remote commit');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

    // Local stranded commit touches synced config AND conflicts.
    makeCommit(local, 'path-map.json', '{"projects":{}}\n', 'path-map commit');
    makeCommit(local, 'shared.ts', 'local\n', 'local shared change');

    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: local });
    try {
      execFileSync('git', ['rebase', 'origin/main'], {
        cwd: local,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* expected conflict */
    }

    const { NomadFatal } = await import('./utils.ts');
    expect(() => recoverForceRemote('rebase', local)).toThrow(NomadFatal);

    // No parking branch should have been created.
    const branches = gitCapture(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// recoverForceRemote - synced-config refusal on dirty tracked paths
// ---------------------------------------------------------------------------

describe('recoverForceRemote - synced-config refusal (dirty tracked)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-dirty-'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses when dirty tracked synced-config file present (merge mode where abort preserves dirty state)', async () => {
    // Build a scenario where the repo is wedged mid-merge (not rebase).
    // After merge --abort, dirty (unstaged) tracked changes to synced-config
    // files are preserved; the safety gate must catch them.
    const origin = join(tmp, 'origin.git');
    const local = join(tmp, 'local');
    mkdirSync(origin, { recursive: true });

    execFileSync('git', ['init', '-q', '-b', 'main', '--bare'], { cwd: origin });
    const seed = join(tmp, 'seed');
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    // Base includes hosts/myhost.json as a tracked synced-config file.
    mkdirSync(join(seed, 'hosts'), { recursive: true });
    writeFileSync(join(seed, 'conflict.ts'), 'v1\n');
    writeFileSync(join(seed, 'hosts', 'myhost.json'), '{"v":1}\n');
    execFileSync('git', ['add', '.'], { cwd: seed });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: seed });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

    execFileSync('git', ['clone', '-q', origin, local]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: local });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: local });

    // Advance origin: changes conflict.ts.
    const other = join(tmp, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
    makeCommit(other, 'conflict.ts', 'remote-v2\n', 'remote commit');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

    // Local commit on a divergent branch (changes conflict.ts to trigger merge conflict).
    makeCommit(local, 'conflict.ts', 'local-v2\n', 'local commit');

    // Fetch then attempt conflicting merge.
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: local });
    try {
      execFileSync('git', ['merge', 'origin/main'], {
        cwd: local,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* expected conflict */
    }

    // Mid-merge: dirty the tracked synced-config file without staging.
    writeFileSync(join(local, 'hosts', 'myhost.json'), '{"dirty":true}\n');

    // Confirm we're wedged mid-merge.
    expect(existsSync(join(local, '.git', 'MERGE_HEAD'))).toBe(true);

    const { NomadFatal } = await import('./utils.ts');
    let thrown: unknown;
    try {
      recoverForceRemote('merge', local);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NomadFatal);
    expect((thrown as Error).message).toMatch(/hosts\/myhost\.json/);

    // No parking branch created (refusal happened before park step).
    const branches = gitCapture(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// recoverForceRemote - untracked files preserved
// ---------------------------------------------------------------------------

describe('recoverForceRemote - untracked files preserved', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-untracked-'));
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('untracked files survive reset --hard', () => {
    const { local } = buildConflictingWedgedRebase(tmp);

    // Create an untracked file.
    writeFileSync(join(local, 'untracked.txt'), 'i am untracked');

    recoverForceRemote('rebase', local);

    expect(existsSync(join(local, 'untracked.txt'))).toBe(true);
  });
});
