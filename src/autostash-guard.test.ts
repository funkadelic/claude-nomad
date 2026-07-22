import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autostashConflictRunbookText, assertNoAutostashConflict } from './autostash-guard.ts';
import { EXIT } from './exit-codes.ts';
import {
  buildUnmergedIndexNoMarker,
  conflictThenStripMarkers,
  gitInit,
  makeCommit,
} from './test-support/git.ts';

/**
 * Tests for `autostashConflictRunbookText`. Pure string-building, so no git
 * fixture is needed here; the unmerged-index cases below exercise the real
 * probe.
 */
describe('autostashConflictRunbookText', () => {
  it('names the resume command and points at recovering content from the stash entry when stashRetained is true', () => {
    const text = autostashConflictRunbookText('nomad pull', true);
    expect(text).toContain('nomad pull');
    expect(text).toContain('stash@{0}: autostash');
    expect(text).toContain("git show 'stash@{0}:<path>'");
    expect(text).toContain('git stash drop');
  });

  it('names the resume command, warns the working tree is the only copy, and does not offer the destructive hard reset when stashRetained is false', () => {
    const text = autostashConflictRunbookText('nomad push', false);
    expect(text).toContain('nomad push');
    expect(text).toContain('the working tree is the only copy of this edit');
    // The hard reset is named only as a warning against using it, never as a
    // numbered recovery step to run.
    expect(text).toContain('Do not run "git reset --hard"');
    expect(text).not.toMatch(/^\s*\d+\.\s*git reset --hard/m);
  });

  it('never instructs a rebase abort as a recovery step and never presents "git reset --mixed HEAD" as the recovery', () => {
    const retained = autostashConflictRunbookText('nomad pull', true);
    const notRetained = autostashConflictRunbookText('nomad push', false);
    for (const text of [retained, notRetained]) {
      expect(text).not.toContain('reset --mixed');
      expect(text).not.toMatch(/^\s*\d+\.\s*git rebase --abort/m);
      expect(text).not.toContain('run "git rebase --abort"');
    }
  });
});

// ---------------------------------------------------------------------------
// Real-git helpers for assertNoAutostashConflict
// ---------------------------------------------------------------------------

/**
 * Build the same unmerged-index state as `buildUnmergedIndexNoMarker`, but
 * with a real orphaned autostash entry created BEFORE the conflict (git
 * refuses `stash push` once the index is already unmerged, so the stash
 * must be created first, on an unrelated untracked path).
 */
function buildUnmergedIndexWithOrphanedStash(dir: string): void {
  gitInit(dir);
  makeCommit(dir, 'file.txt', 'base\n', 'base');
  mkdirSync(join(dir, 'scratch'));
  writeFileSync(join(dir, 'scratch', 'dummy.txt'), 'unused\n');
  execFileSync('git', ['stash', 'push', '-u', '-m', 'On main: autostash'], { cwd: dir });
  conflictThenStripMarkers(dir);
}

describe('assertNoAutostashConflict', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-autostash-guard-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns silently when the index is clean', () => {
    gitInit(tmp);
    makeCommit(tmp, 'a.ts', 'x\n', 'initial');
    expect(() => assertNoAutostashConflict(tmp, 'nomad pull')).not.toThrow();
  });

  it('throws NomadFatal with EXIT.CONFLICT when the index has unmerged entries', () => {
    buildUnmergedIndexNoMarker(tmp);
    let caught: unknown;
    try {
      assertNoAutostashConflict(tmp, 'nomad pull');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(EXIT.CONFLICT);
    expect((caught as Error).message).toContain('nomad pull');
  });

  it('names the autostash entry in the thrown message when one is present', () => {
    buildUnmergedIndexWithOrphanedStash(tmp);
    let caught: unknown;
    try {
      assertNoAutostashConflict(tmp, 'nomad push');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('stash@{0}: autostash');
  });

  it('fails closed: aborts with EXIT.CONFLICT when the index probe itself errors (non-git dir)', () => {
    // No gitInit: `git diff` exits 128 in a non-repo, forcing the probe's
    // 'error' outcome. A fail-open guard would return silently here and let
    // conflict-markered config through; the fail-closed guard must abort.
    let caught: unknown;
    try {
      assertNoAutostashConflict(tmp, 'nomad pull');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(EXIT.CONFLICT);
    expect((caught as Error).message).toContain('nomad pull');
    // On 'error' the stash probe is skipped (it would run another unbounded
    // git command and could hang), so stashRetained defaults to false: the
    // message selects the safe no-stash runbook and never claims a stash entry.
    expect((caught as Error).message).toContain('the working tree is the only copy');
    expect((caught as Error).message).not.toContain('stash@{0}: autostash');
  });
});
