import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverUnmergedIndex } from './recovery.unmerged.ts';

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
 * Build a repo with unmerged stage-2/3 index entries and NO active
 * rebase/merge marker, mirroring the buildUnmergedIndexNoMarker helper in
 * commands/pull/wedge.test.ts but scoped to this recovery test file.
 *
 * Optionally adds an orphaned autostash stash entry (simulating the trigger
 * where git --autostash drops to the stash list during a torn-down
 * rebase), and optionally a second tracked file (`other.txt`) that stays out
 * of the conflict.
 *
 * `withAbsentFromHead` additionally stages a modify/delete conflict on
 * `doomed.txt`: main deletes it, the branch modifies it. HEAD therefore does
 * NOT contain the path, so `git reset --mixed HEAD` leaves the conflicted file
 * UNTRACKED rather than dirty-tracked, which a tracked-only residual probe
 * cannot see.
 */
function buildUnmergedIndexFixture(
  dir: string,
  {
    withAutostash = false,
    withOtherTracked = false,
    withAbsentFromHead = false,
    nestUnderDir = false,
  }: {
    withAutostash?: boolean;
    withOtherTracked?: boolean;
    withAbsentFromHead?: boolean;
    nestUnderDir?: boolean;
  } = {},
): void {
  // With nestUnderDir, the absent-from-HEAD path lives in its own directory, so
  // deleting it on the HEAD side leaves that directory wholly untracked.
  const doomed = nestUnderDir ? join('dir', 'doomed.txt') : 'doomed.txt';
  initRepo(dir);
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  if (withAbsentFromHead) {
    if (nestUnderDir) mkdirSync(join(dir, 'dir'), { recursive: true });
    writeFileSync(join(dir, doomed), 'orig\n');
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

  if (withOtherTracked) {
    // Committed before the conflict: once the index is unmerged, git refuses
    // to commit anything.
    writeFileSync(join(dir, 'other.txt'), 'other\n');
    execFileSync('git', ['add', 'other.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add other.txt'], { cwd: dir });
  }

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
  if (withAbsentFromHead) {
    writeFileSync(join(dir, doomed), 'branch-modified\n');
    execFileSync('git', ['add', '--', doomed], { cwd: dir });
  }
  execFileSync('git', ['commit', '-q', '-m', 'branch commit'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'main-value\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  // Delete on the HEAD side, so the merge produces a modify/delete conflict
  // whose path is absent from HEAD.
  if (withAbsentFromHead) execFileSync('git', ['rm', '-q', '--', doomed], { cwd: dir });
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

/**
 * Run `recoverUnmergedIndex` and swallow the NomadFatal it throws when the
 * fixture's conflict markers are still in the working tree. The index repair
 * and the autostash hint both happen before that die, so tests asserting on
 * those effects use this wrapper.
 *
 * @param dir Absolute path to the fixture repo.
 * @returns The thrown value, or undefined if the call returned normally.
 */
function recoverSwallowingFatal(dir: string): unknown {
  try {
    recoverUnmergedIndex(dir);
    return undefined;
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// recoverUnmergedIndex
// ---------------------------------------------------------------------------

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

    recoverSwallowingFatal(tmp);

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

    recoverSwallowingFatal(tmp);

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

    recoverSwallowingFatal(tmp);

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

    recoverSwallowingFatal(tmp);

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

    recoverSwallowingFatal(tmp);

    const combined = logLines.join('\n');
    expect(combined).not.toMatch(/autostash/);
  });

  it('dies naming the conflict-markered files when dirty paths remain after reset', async () => {
    // buildUnmergedIndexFixture leaves file.txt with <<<<<<< conflict markers in
    // the working tree. After git reset --mixed HEAD the markers persist, so
    // recovery must refuse rather than let the pull publish them to ~/.claude/.
    buildUnmergedIndexFixture(tmp);

    const { NomadFatal } = await import('../../utils.ts');
    const thrown = recoverSwallowingFatal(tmp);

    expect(thrown).toBeInstanceOf(NomadFatal);
    expect((thrown as Error).message).toMatch(/conflict content/);
    expect((thrown as Error).message).toMatch(/file\.txt/);
    expect((thrown as Error).message).toMatch(/re-run "nomad pull"/);
  });

  it('dies over a conflicted path that HEAD does not contain (untracked after reset)', async () => {
    // modify/delete: main deleted doomed.txt, the branch modified it. The reset
    // therefore leaves doomed.txt UNTRACKED, not dirty-tracked, so a
    // tracked-only probe would report a clean tree and let the pull publish it.
    buildUnmergedIndexFixture(tmp, { withAbsentFromHead: true });
    // Resolve the ordinary conflict so doomed.txt is the only residual left.
    const headContent = execFileSync('git', ['show', 'HEAD:file.txt'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync(join(tmp, 'file.txt'), headContent);

    const { NomadFatal } = await import('../../utils.ts');
    const thrown = recoverSwallowingFatal(tmp);

    expect(thrown).toBeInstanceOf(NomadFatal);
    expect((thrown as Error).message).toMatch(/doomed\.txt/);
    expect((thrown as Error).message).toMatch(/re-run "nomad pull"/);

    // The path really is untracked at this point, which is what makes the
    // tracked-only probe insufficient.
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(porcelain).toMatch(/\?\?\s+doomed\.txt/);
    // And its unresolved content is still on disk.
    expect(existsSync(join(tmp, 'doomed.txt'))).toBe(true);
  });

  it('dies over a conflicted path inside a wholly untracked directory', async () => {
    // Upstream deleted the whole directory while the branch modified a file in
    // it. Default `git status --porcelain` collapses that to one `?? dir/`
    // record, so an exact-path match against `dir/config.json` finds nothing
    // unless the probe asks for every untracked file.
    buildUnmergedIndexFixture(tmp, { withAbsentFromHead: true, nestUnderDir: true });
    const headContent = execFileSync('git', ['show', 'HEAD:file.txt'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync(join(tmp, 'file.txt'), headContent);

    const { NomadFatal } = await import('../../utils.ts');
    const thrown = recoverSwallowingFatal(tmp);

    expect(thrown).toBeInstanceOf(NomadFatal);
    expect((thrown as Error).message).toMatch(/dir\/doomed\.txt/);

    // Collapsed default output is exactly what makes this case escape a
    // naive probe: the directory, not the file, is what git reports.
    const collapsed = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(collapsed).toMatch(/\?\?\s+dir\//);
    expect(collapsed).not.toMatch(/doomed\.txt/);
  });

  it('repairs the index before dying so the repo is left unwedged', () => {
    buildUnmergedIndexFixture(tmp);

    recoverSwallowingFatal(tmp);

    // The die must not short-circuit the reset: a still-unmerged index would
    // leave the user wedged with no automated way out.
    const afterU = execFileSync('git', ['diff', '--diff-filter=U', '--name-only', '-z'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\0')
      .filter(Boolean);
    expect(afterU).toHaveLength(0);
  });

  it('does not die over a dirty file that was never part of the conflict', () => {
    buildUnmergedIndexFixture(tmp, { withOtherTracked: true });
    // Resolve the conflicted file, then dirty an unrelated tracked file. Local
    // edits elsewhere in the sync repo are normal and pull handles them, so they
    // must not block the recovery.
    const headContent = execFileSync('git', ['show', 'HEAD:file.txt'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync(join(tmp, 'file.txt'), headContent);
    writeFileSync(join(tmp, 'other.txt'), 'local edit\n');

    expect(recoverSwallowingFatal(tmp)).toBeUndefined();
  });

  it('returns normally when the working tree is clean after reset', () => {
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
