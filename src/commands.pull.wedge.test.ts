import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectWedge } from './commands.pull.wedge.ts';

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
