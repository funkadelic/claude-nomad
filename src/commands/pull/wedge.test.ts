import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildUnmergedIndexNoMarker, gitInit, makeCommit } from '../../test-support/git.ts';

import {
  classifyWedge,
  classifyWedgeWithProbe,
  cleanRepoForceRemoteMessage,
  detectWedge,
  orphanedAutostashPresent,
  probeUnmergedIndex,
  unmergedIndexPresent,
} from './wedge.ts';

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
// Real-git helpers (mirrors commands/pull/recovery.test.ts style)
// ---------------------------------------------------------------------------

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
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(unmergedIndexPresent(tmp)).toBe(false);
  });
});

describe('probeUnmergedIndex', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-probe-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'unmerged' when the index has stage-2/3 entries", () => {
    buildUnmergedIndexNoMarker(tmp);
    expect(probeUnmergedIndex(tmp)).toBe('unmerged');
  });

  it("returns 'clean' on a clean committed repo", () => {
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(probeUnmergedIndex(tmp)).toBe('clean');
  });

  it("returns 'error' in a non-git directory (probe cannot run)", () => {
    expect(probeUnmergedIndex(tmp)).toBe('error');
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
    gitInit(tmp);
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
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    writeFileSync(join(tmp, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(classifyWedge(tmp)).toBe('merge');
  });

  it('returns null on a non-git directory (index probe errors; fail-open bias)', () => {
    // tmp is a bare mkdtempSync directory: no gitInit call, so the index
    // probe cannot run at all (probeUnmergedIndex returns 'error'). This is
    // the characterization case: classifyWedge's fail-open bias collapses
    // 'error' into null exactly like a genuinely clean repo, which is
    // deliberate and must survive future refactors untouched.
    expect(classifyWedge(tmp)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyWedgeWithProbe
// ---------------------------------------------------------------------------

/**
 * `classifyWedgeWithProbe` pairs `classifyWedge`'s state with the raw
 * `IndexProbe` outcome that produced it. These tests pin two things at once:
 * the `state` matches `classifyWedge`'s existing values (a characterization
 * check, run in parallel to the dedicated `classifyWedge` describe above),
 * and the `probe` field distinguishes a verified-clean repo from one nomad
 * could not determine, the distinction `handleWedge`'s `--force-remote` info
 * line depends on.
 */
describe('classifyWedgeWithProbe', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-classify-probe-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns { state: null, probe: "clean" } on a genuinely clean committed repo', () => {
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(classifyWedgeWithProbe(tmp)).toEqual({ state: null, probe: 'clean' });
  });

  it('returns { state: null, probe: "error" } on a non-git directory (probe cannot run)', () => {
    // No gitInit: the index probe fails outright, distinct from a verified
    // clean state even though both collapse to state: null.
    expect(classifyWedgeWithProbe(tmp)).toEqual({ state: null, probe: 'error' });
  });

  it('returns { state: "unmerged-index", probe: "unmerged" } when the index has unmerged entries', () => {
    buildUnmergedIndexNoMarker(tmp);
    expect(classifyWedgeWithProbe(tmp)).toEqual({ state: 'unmerged-index', probe: 'unmerged' });
  });

  it('returns { state: "rebase", probe: "clean" } on a rebase marker (index probe never runs)', () => {
    mkdirSync(join(tmp, '.git'));
    mkdirSync(join(tmp, '.git', 'rebase-merge'));
    expect(classifyWedgeWithProbe(tmp)).toEqual({ state: 'rebase', probe: 'clean' });
  });

  it('returns { state: "merge", probe: "clean" } on MERGE_HEAD (index probe never runs)', () => {
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    writeFileSync(join(tmp, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    expect(classifyWedgeWithProbe(tmp)).toEqual({ state: 'merge', probe: 'clean' });
  });
});

// ---------------------------------------------------------------------------
// cleanRepoForceRemoteMessage
// ---------------------------------------------------------------------------

describe('cleanRepoForceRemoteMessage', () => {
  it('prints the approved verbatim string when the probe verified the repo is clean', () => {
    expect(cleanRepoForceRemoteMessage('clean')).toBe(
      'repo is clean, nothing to recover; continuing with a normal pull',
    );
  });

  it('does NOT claim the repo is clean when the probe could not determine wedge state', () => {
    const message = cleanRepoForceRemoteMessage('error');
    expect(message).not.toContain('repo is clean');
    expect(message).toMatch(/could not determine/);
    expect(message).toMatch(/continuing with a normal pull/);
  });
});

// ---------------------------------------------------------------------------
// orphanedAutostashPresent
// ---------------------------------------------------------------------------

describe('orphanedAutostashPresent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-autostash-'));
    gitInit(tmp);
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
// unmergedIndexPresent / orphanedAutostashPresent - non-git dir resilience
// ---------------------------------------------------------------------------

describe('unmergedIndexPresent - non-git dir returns false', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-nonrepo-'));
    // NOT a git repo: no gitInit call.
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
    // NOT a git repo: no gitInit call.
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false on a non-git directory (no stack trace thrown)', () => {
    expect(orphanedAutostashPresent(tmp)).toBe(false);
  });
});
