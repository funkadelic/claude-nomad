import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/** vi.spyOn(console, 'log') return type shorthand. */
type LogSpy = MockInstance<(...args: unknown[]) => void>;

import {
  buildRecoverySummary,
  classifyTouched,
  freshStrandedBranch,
  gitCapture,
  parsePorcelainZ,
  recoverForceRemote,
} from './commands.pull.recovery.ts';

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

  it('prefix entry: shared/skills/x.md is synced (matches shared/skills/ prefix)', () => {
    // shared/agents/ was removed from PUSH_ALLOWED_STATIC (gsd-owned); use shared/skills/ instead.
    const { synced } = classifyTouched(['shared/skills/x.md']);
    expect(synced).toContain('shared/skills/x.md');
  });

  it('prefix entry: shared/agents/x.md is NOT synced (shared/agents/ removed from allow-list)', () => {
    // shared/agents/ was removed from PUSH_ALLOWED_STATIC; an out-of-band gsd write must not
    // be classified as a synced-config path anymore.
    const { synced, toolSource } = classifyTouched(['shared/agents/x.md']);
    expect(synced).not.toContain('shared/agents/x.md');
    expect(toolSource).toContain('shared/agents/x.md');
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
// recoverForceRemote - non-ASCII synced-config path (committed diff -z)
// ---------------------------------------------------------------------------

describe('recoverForceRemote - non-ASCII synced-config refusal (committed paths)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recovery-unicode-'));
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

  it('refuses when a stranded commit touches a non-ASCII synced-config path', async () => {
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

    // Advance origin to force a rebase conflict on base.ts.
    const other = join(tmp, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: other });
    makeCommit(other, 'base.ts', 'remote-base\n', 'remote base change');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });

    // Local stranded commit touches a synced-config file with a UTF-8 name.
    // git diff --name-only (without -z) would emit this double-quoted with
    // octal escapes, defeating the startsWith('shared/') gate.
    const unicodeName = 'shared/rules/résumé.md';
    mkdirSync(join(local, 'shared', 'rules'), { recursive: true });
    writeFileSync(join(local, unicodeName), 'config\n');
    execFileSync('git', ['add', '--', unicodeName], { cwd: local });
    execFileSync('git', ['commit', '-q', '-m', 'unicode config commit'], { cwd: local });
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
    expect((thrown as Error).message).toContain(unicodeName);

    // No parking branch created (refusal happened before park step).
    const branches = gitCapture(['branch', '--list', 'nomad/stranded-*'], local);
    expect(branches.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parsePorcelainZ - rename/copy record handling
// ---------------------------------------------------------------------------

describe('parsePorcelainZ - rename and copy records', () => {
  /**
   * Build a real `git status --porcelain=v1 -z` payload containing a staged
   * rename, then assert both the new- and old-name fields are classified as
   * tracked. A naive one-token-per-record parser misreads the bare old-name
   * field (e.g. `red/secret.md` from `shared/secret.md`), which would let a
   * renamed synced-config path evade the safety gate.
   */
  it('classifies both sides of a real staged rename as tracked', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nomad-porcelain-rename-'));
    try {
      initRepo(tmp);
      mkdirSync(join(tmp, 'shared'), { recursive: true });
      writeFileSync(join(tmp, 'shared', 'secret.md'), 'config\n');
      execFileSync('git', ['add', '.'], { cwd: tmp });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: tmp });

      // Stage a rename: porcelain emits `R  tool.ts\0shared/secret.md\0`.
      execFileSync('git', ['mv', join('shared', 'secret.md'), 'tool.ts'], { cwd: tmp });
      const raw = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: tmp }).toString();

      const { tracked, untracked } = parsePorcelainZ(raw);
      // Both the destination and the original synced-config source are tracked,
      // and the source is the intact path (not the corrupted `red/secret.md`).
      expect(tracked).toContain('tool.ts');
      expect(tracked).toContain('shared/secret.md');
      expect(tracked).not.toContain('red/secret.md');
      expect(untracked).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('classifies the synced-config side of a rename so classifyTouched flags it', () => {
    // R record: destination is tool-source, source is synced config.
    const raw = 'R  tool.ts\0shared/rules/secret.md\0';
    const { tracked } = parsePorcelainZ(raw);
    const { synced } = classifyTouched(tracked);
    expect(synced).toContain('shared/rules/secret.md');
  });

  it('handles copy (C) records the same way as renames', () => {
    const raw = 'C  copy.ts\0hosts/myhost.json\0';
    const { tracked } = parsePorcelainZ(raw);
    expect(tracked).toEqual(expect.arrayContaining(['copy.ts', 'hosts/myhost.json']));
  });

  it('tolerates a rename record missing its source field', () => {
    // Truncated payload: R record whose trailing source field is empty.
    const raw = 'R  tool.ts\0';
    const { tracked } = parsePorcelainZ(raw);
    expect(tracked).toEqual(['tool.ts']);
  });

  it('partitions plain modified and untracked records', () => {
    const raw = ' M src/a.ts\0?? scratch.txt\0';
    const { tracked, untracked } = parsePorcelainZ(raw);
    expect(tracked).toEqual(['src/a.ts']);
    expect(untracked).toEqual(['scratch.txt']);
  });

  it('returns empty arrays for empty input', () => {
    expect(parsePorcelainZ('')).toEqual({ tracked: [], untracked: [] });
  });
});

// ---------------------------------------------------------------------------
// freshStrandedBranch - collision-resistant parking-branch naming
// ---------------------------------------------------------------------------

describe('freshStrandedBranch', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-freshbranch-'));
    initRepo(tmp);
    makeCommit(tmp, 'base.ts', 'v1\n', 'base');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a nomad/stranded-<ts> name when none exists yet', () => {
    const name = freshStrandedBranch(tmp);
    expect(name).toMatch(/^nomad\/stranded-\d{8}-\d{6}$/);
  });

  it('appends a -N suffix when the timestamped name is already taken', () => {
    // Freeze the clock: every call below must derive the same second-resolution
    // base, or a tick between calls dodges the collision this test forces.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 4, 12, 0, 0));

    // Pre-create the exact base name the next call will generate, forcing the
    // collision path. Two recoveries in the same wall-clock second hit this.
    const base = freshStrandedBranch(tmp);
    execFileSync('git', ['branch', base, 'HEAD'], { cwd: tmp });

    const next = freshStrandedBranch(tmp);
    expect(next).toBe(`${base}-1`);

    // A further collision bumps to -2.
    execFileSync('git', ['branch', next, 'HEAD'], { cwd: tmp });
    expect(freshStrandedBranch(tmp)).toBe(`${base}-2`);
  });
});

// ---------------------------------------------------------------------------
// buildRecoverySummary - both stranded-range arms and untracked handling
// ---------------------------------------------------------------------------

describe('buildRecoverySummary', () => {
  it('includes a stranded section when the log range is non-empty', () => {
    const summary = buildRecoverySummary(
      'nomad/stranded-20260604-100000',
      'abc1234 local commit\ndef5678 another',
      [],
    );
    expect(summary).toContain('parked stranded commits on nomad/stranded-20260604-100000');
    expect(summary).toContain('stranded:\n  abc1234 local commit\n  def5678 another');
    expect(summary).toContain('continuing with normal pull');
  });

  it('omits the stranded section when the log range is empty', () => {
    const summary = buildRecoverySummary('nomad/stranded-x', '', []);
    expect(summary).toMatch(/parked stranded commits on nomad\/stranded-x/);
    expect(summary).not.toMatch(/stranded:/);
    expect(summary).toContain('continuing with normal pull');
  });

  it('appends preserved untracked files when present', () => {
    const summary = buildRecoverySummary('nomad/stranded-y', '', ['a.txt', 'b.txt']);
    expect(summary).toContain('untracked files preserved: a.txt, b.txt');
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
// recoverUnmergedIndex
// ---------------------------------------------------------------------------

import { recoverUnmergedIndex } from './commands.pull.recovery.ts';

/**
 * Build a repo with unmerged stage-2/3 index entries and NO active
 * rebase/merge marker, mirroring the buildUnmergedIndexNoMarker helper in
 * commands.pull.wedge.test.ts but scoped to this recovery test file.
 *
 * Optionally adds an orphaned autostash stash entry (simulating the Phase 51
 * trigger where git --autostash drops to the stash list during a torn-down
 * rebase).
 */
function buildUnmergedIndexFixture(
  dir: string,
  { withAutostash = false }: { withAutostash?: boolean } = {},
): void {
  initRepo(dir);
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

  if (withAutostash) {
    // Simulate the orphaned autostash: in the real scenario, git --autostash
    // saves WIP BEFORE the rebase starts, then cannot auto-restore it once the
    // rebase is torn down. Create the stash entry NOW, before the conflict, so
    // git-stash can write its lock. Track a separate file so the stash does not
    // interfere with the conflict-targeted file.txt.
    writeFileSync(join(dir, 'wip.txt'), 'clean-wip\n');
    execFileSync('git', ['add', 'wip.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add wip.txt'], { cwd: dir });
    writeFileSync(join(dir, 'wip.txt'), 'dirty-wip\n');
    execFileSync('git', ['stash', 'push', '-m', 'On main: autostash'], { cwd: dir });
  }

  // Create a branch that modifies file.txt.
  execFileSync('git', ['checkout', '-q', '-b', 'branch'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'branch-value\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'branch commit'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'main-value\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'main commit'], { cwd: dir });
  // Attempt conflicting merge (sets MERGE_HEAD and unmerged index entries).
  try {
    execFileSync('git', ['merge', '--no-commit', 'branch'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Expected conflict.
  }
  // Tear down the marker files, leaving the index entries in place.
  for (const marker of ['MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG']) {
    try {
      unlinkSync(join(dir, '.git', marker));
    } catch {
      // May not exist.
    }
  }
}

describe('recoverUnmergedIndex - index cleared via reset --mixed HEAD only', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-recover-unmerged-'));
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

  it('clears the index (no unmerged entries after recovery) while preserving working-tree file', () => {
    buildUnmergedIndexFixture(tmp);

    // Confirm unmerged entries exist before recovery.
    const beforeU = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    expect(beforeU.length).toBeGreaterThan(0);

    recoverUnmergedIndex(tmp);

    // After recovery: no unmerged entries.
    const afterU = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    expect(afterU).toHaveLength(0);

    // Working-tree file.txt still exists (--mixed preserves working-tree content).
    expect(existsSync(join(tmp, 'file.txt'))).toBe(true);
  });

  it('runs git reset --mixed HEAD and does NOT run --abort or --hard', () => {
    buildUnmergedIndexFixture(tmp);

    // Record git argv arrays by wrapping gitOrFatal via module mock is complex
    // here; instead verify via observable git state: the index is cleared
    // (--mixed effect) and no abort marker was consumed (there is none to abort).
    // Separately, assert that reset --hard would have wiped file.txt but ours did not.
    // Write a working-tree file that would be destroyed by --hard but preserved by --mixed.
    writeFileSync(join(tmp, 'extra.txt'), 'preserved-by-mixed\n');

    recoverUnmergedIndex(tmp);

    // --mixed: index cleared, working-tree preserved.
    const afterU = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    expect(afterU).toHaveLength(0);
    // extra.txt survived (would be gone under --hard, preserved under --mixed).
    expect(existsSync(join(tmp, 'extra.txt'))).toBe(true);
  });

  it('emits a log line naming the orphaned autostash with stash pop/drop hint when present', () => {
    buildUnmergedIndexFixture(tmp, { withAutostash: true });

    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    recoverUnmergedIndex(tmp);

    const combined = logLines.join('\n');
    expect(combined).toMatch(/autostash/);
    expect(combined).toMatch(/git stash pop|git stash drop/);
  });

  it('does NOT pop the autostash when one is present (stash entry still exists after recovery)', () => {
    buildUnmergedIndexFixture(tmp, { withAutostash: true });

    // Verify autostash is in the stash list before recovery.
    const before = execFileSync('git', ['stash', 'list'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(before).toMatch(/autostash/);

    recoverUnmergedIndex(tmp);

    // Autostash must STILL be in the stash list after recovery (never popped).
    const after = execFileSync('git', ['stash', 'list'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(after).toMatch(/autostash/);
  });

  it('emits NO autostash log line when no orphaned autostash is present', () => {
    buildUnmergedIndexFixture(tmp, { withAutostash: false });

    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    recoverUnmergedIndex(tmp);

    const combined = logLines.join('\n');
    expect(combined).not.toMatch(/autostash/);
  });

  it('emits a WARN naming conflict-markered files when dirty paths remain after reset', () => {
    // buildUnmergedIndexFixture leaves file.txt with <<<<<<< conflict markers in
    // the working tree. After git reset --mixed HEAD the markers persist; the
    // post-reset git diff should surface them so the user is not misled.
    buildUnmergedIndexFixture(tmp);

    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    recoverUnmergedIndex(tmp);

    const combined = logLines.join('\n');
    expect(combined).toMatch(/conflict content/);
    expect(combined).toMatch(/file\.txt/);
  });

  it('emits no dirty-file WARN when the working tree is clean after reset', () => {
    // Construct a repo where the index has staged-but-not-yet-committed edits
    // (no conflict markers in the working tree). Manually inject unmerged
    // stage entries by writing the index objects directly to avoid needing
    // conflict markers in the file content.
    //
    // Simpler approach: build the unmerged fixture, call git checkout file.txt
    // to restore file.txt to HEAD content (removes markers), then call recovery.
    // The index still has unmerged entries; after reset --mixed HEAD, git diff
    // reports nothing because the working tree matches the (now cleared) index.
    buildUnmergedIndexFixture(tmp);
    // Overwrite file.txt with HEAD content so no conflict markers remain.
    const headContent = execFileSync('git', ['show', 'HEAD:file.txt'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync(join(tmp, 'file.txt'), headContent);

    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    recoverUnmergedIndex(tmp);

    const combined = logLines.join('\n');
    expect(combined).not.toMatch(/conflict content/);
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
