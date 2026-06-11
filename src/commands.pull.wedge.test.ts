import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyWedge,
  detectWedge,
  orphanedAutostashPresent,
  unmergedIndexPresent,
} from './commands.pull.wedge.ts';

/**
 * Tests for `detectWedge`. Each case constructs a minimal `.git/` scaffold in
 * a real temp directory and probes the returned WedgeMode. Behavior-focused:
 * only the returned value is asserted, not internal calls.
 */
describe('detectWedge', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'nomad-wedge-test-'));
    // Minimal .git/ scaffold: detectWedge only probes inside .git/
    mkdirSync(join(tmpRepo, '.git'));
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('returns null on a clean repo (no marker files)', () => {
    expect(detectWedge(tmpRepo)).toBeNull();
  });

  it('returns "rebase" when .git/rebase-merge exists (interactive/merge-backend rebase)', () => {
    mkdirSync(join(tmpRepo, '.git', 'rebase-merge'));
    expect(detectWedge(tmpRepo)).toBe('rebase');
  });

  it('returns "rebase" when .git/rebase-apply exists (am-backend rebase)', () => {
    mkdirSync(join(tmpRepo, '.git', 'rebase-apply'));
    expect(detectWedge(tmpRepo)).toBe('rebase');
  });

  it('returns "merge" when .git/MERGE_HEAD exists and no rebase marker is present', () => {
    writeFileSync(join(tmpRepo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(detectWedge(tmpRepo)).toBe('merge');
  });

  it('returns "rebase" when both rebase-merge and MERGE_HEAD are present (rebase wins)', () => {
    mkdirSync(join(tmpRepo, '.git', 'rebase-merge'));
    writeFileSync(join(tmpRepo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(detectWedge(tmpRepo)).toBe('rebase');
  });

  it('returns "rebase" when both rebase-apply and MERGE_HEAD are present (rebase wins)', () => {
    mkdirSync(join(tmpRepo, '.git', 'rebase-apply'));
    writeFileSync(join(tmpRepo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(detectWedge(tmpRepo)).toBe('rebase');
  });
});

// ---------------------------------------------------------------------------
// Real-git helpers (mirrors commands.pull.recovery.test.ts style)
// ---------------------------------------------------------------------------

/** Create a real git repo at `dir` with user identity configured. */
function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
}

/** Create a commit in `repo` with `content` written to `file`. */
function makeCommit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  execFileSync('git', ['add', file], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo });
}

/**
 * Build a repo that has unmerged stage-2/3 index entries but NO active
 * rebase/merge marker (the exact torn-down-rebase dead end from Phase 51).
 *
 * Approach: start a conflicting merge (which sets MERGE_HEAD), then remove
 * the MERGE_HEAD/MERGE_MODE/MERGE_MSG marker files. The index retains the
 * unmerged entries; `git diff --diff-filter=U` still reports them.
 */
function buildUnmergedIndexNoMarker(dir: string): void {
  initRepo(dir);
  makeCommit(dir, 'file.txt', 'base\n', 'base');
  // Create a branch that changes file.txt.
  execFileSync('git', ['checkout', '-q', '-b', 'branch'], { cwd: dir });
  makeCommit(dir, 'file.txt', 'branch-value\n', 'branch commit');
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  makeCommit(dir, 'file.txt', 'main-value\n', 'main commit');
  // Attempt merge -- will conflict.
  try {
    execFileSync('git', ['merge', '--no-commit', 'branch'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Expected conflict.
  }
  // Tear down the marker files, leaving the unmerged index entries behind.
  const gitDir = join(dir, '.git');
  for (const marker of ['MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG']) {
    try {
      unlinkSync(join(gitDir, marker));
    } catch {
      // May not exist if merge exited differently.
    }
  }
}

// ---------------------------------------------------------------------------
// unmergedIndexPresent
// ---------------------------------------------------------------------------

describe('unmergedIndexPresent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-unmerged-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when the index has unmerged entries and no marker is present', () => {
    buildUnmergedIndexNoMarker(tmp);
    expect(unmergedIndexPresent(tmp)).toBe(true);
  });

  it('returns false on a clean committed repo (no unmerged entries)', () => {
    initRepo(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(unmergedIndexPresent(tmp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyWedge
// ---------------------------------------------------------------------------

describe('classifyWedge', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-classify-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null on a clean committed repo', () => {
    initRepo(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(classifyWedge(tmp)).toBeNull();
  });

  it('returns "unmerged-index" when index is unmerged and no marker is present', () => {
    buildUnmergedIndexNoMarker(tmp);
    expect(classifyWedge(tmp)).toBe('unmerged-index');
  });

  it('returns "rebase" when rebase marker is present even if index is also unmerged (marker precedence)', () => {
    buildUnmergedIndexNoMarker(tmp);
    // Add a rebase-merge marker dir to simulate a torn-down-but-not-aborted rebase.
    mkdirSync(join(tmp, '.git', 'rebase-merge'));
    expect(classifyWedge(tmp)).toBe('rebase');
  });

  it('returns "merge" when MERGE_HEAD is present (marker precedence over index state)', () => {
    initRepo(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    writeFileSync(join(tmp, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(classifyWedge(tmp)).toBe('merge');
  });
});

// ---------------------------------------------------------------------------
// orphanedAutostashPresent
// ---------------------------------------------------------------------------

describe('orphanedAutostashPresent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-autostash-'));
    initRepo(tmp);
    makeCommit(tmp, 'a.ts', 'initial\n', 'initial');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when a stash entry subject contains "autostash"', () => {
    // Create a stash entry with an autostash-style message (git writes
    // "On <branch>: autostash" for dropped autostashes; we simulate it with
    // -m to reliably reproduce the subject).
    writeFileSync(join(tmp, 'a.ts'), 'dirty\n');
    execFileSync('git', ['stash', 'push', '-m', 'On main: autostash'], { cwd: tmp });
    expect(orphanedAutostashPresent(tmp)).toBe(true);
  });

  it('returns false when the stash list is empty', () => {
    expect(orphanedAutostashPresent(tmp)).toBe(false);
  });

  it('returns false when the stash contains only non-autostash entries', () => {
    writeFileSync(join(tmp, 'a.ts'), 'dirty\n');
    execFileSync('git', ['stash', 'push', '-m', 'my ordinary stash entry'], { cwd: tmp });
    expect(orphanedAutostashPresent(tmp)).toBe(false);
  });

  it('returns false for a user stash whose message contains "autostash" mid-sentence (false-positive guard)', () => {
    // A stash like "wip on autostash detection feature" must NOT match:
    // the regex anchors on the trailing `: autostash` form git uses.
    writeFileSync(join(tmp, 'a.ts'), 'dirty\n');
    execFileSync('git', ['stash', 'push', '-m', 'wip on autostash detection feature'], {
      cwd: tmp,
    });
    expect(orphanedAutostashPresent(tmp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unmergedIndexPresent / orphanedAutostashPresent - non-git dir resilience (WR-02)
// ---------------------------------------------------------------------------

describe('unmergedIndexPresent - non-git dir returns false', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-nonrepo-'));
    // NOT a git repo: no initRepo call.
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false on a non-git directory (no stack trace thrown)', () => {
    expect(unmergedIndexPresent(tmp)).toBe(false);
  });
});

describe('orphanedAutostashPresent - non-git dir returns false', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-nonrepo-stash-'));
    // NOT a git repo: no initRepo call.
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false on a non-git directory (no stack trace thrown)', () => {
    expect(orphanedAutostashPresent(tmp)).toBe(false);
  });
});
