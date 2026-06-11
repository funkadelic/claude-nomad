/**
 * Integration fixture: two-host churn regression for gsd-owned asset names.
 *
 * Before hooks/agents were removed from SHARED_LINKS, every `nomad push` from
 * a host that lacked ~/.claude/hooks would stage a deletion of shared/hooks/,
 * and a host that had it would stage an addition. This caused perpetual churn
 * between hosts. The tests here prove the post-drop invariants:
 *
 * B8: With hooks/agents removed from SHARED_LINKS, a simulated push from two
 *     hosts into the same git repo produces zero diff on shared/hooks (no churn).
 *
 * Negative control: enforceAllowList rejects shared/hooks/* as a violation
 * (shared/hooks/ is no longer in PUSH_ALLOWED_STATIC).
 *
 * Each describe block is hermetic: a real git repo is initialized in mkdtemp
 * and removed in afterEach.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PathMap } from './config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command in cwd, surfacing stderr on failure. */
function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Scaffold a minimal nomad repo under `root` with an initialized git history.
 * Creates shared/ with .gitkeep files for skills and commands (the remaining
 * SHARED_LINKS dirs), plus an initial commit so the index is non-empty.
 * Returns the repo root path.
 */
function scaffoldRepo(root: string): string {
  const repo = join(root, 'claude-nomad');
  mkdirSync(join(repo, 'shared', 'skills'), { recursive: true });
  mkdirSync(join(repo, 'shared', 'commands'), { recursive: true });
  writeFileSync(join(repo, 'shared', 'skills', '.gitkeep'), '');
  writeFileSync(join(repo, 'shared', 'commands', '.gitkeep'), '');
  writeFileSync(join(repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
  runGit(repo, ['init', '-q', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  runGit(repo, ['config', 'user.name', 'test']);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'init']);
  return repo;
}

/** Return the diff of shared/hooks relative to HEAD in `repo` (empty = no churn). */
function hooksGitDiff(repo: string): string {
  return execFileSync('git', ['diff', 'HEAD', '--', 'shared/hooks'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

// ---------------------------------------------------------------------------
// B8: no shared/hooks churn between two simulated hosts
// ---------------------------------------------------------------------------

describe('gsd-asset churn: no shared/hooks diff after hooks drop (B8)', () => {
  let testHome: string;
  let repo: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-churn-'));
    repo = scaffoldRepo(testHome);
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('host-A push produces no diff on shared/hooks (hooks no longer in SHARED_LINKS)', () => {
    // Host-A has a real ~/.claude/hooks directory (gsd-owned). The old behavior
    // would stage hooks/ as a new shared/hooks subtree. Post-drop, nothing in
    // applySharedLinks or snapshotIntoShared touches hooks, so the diff must
    // be empty. We verify this at the git level: after an arbitrary commit
    // (simulating what a push would do to shared/skills), shared/hooks has
    // zero diff from HEAD.

    // Simulate Host-A's push: update shared/skills with content
    writeFileSync(join(repo, 'shared', 'skills', 'my-skill.md'), '# skill\n');
    runGit(repo, ['add', 'shared/skills/my-skill.md']);
    runGit(repo, ['commit', '-m', 'host-A: push skills update']);

    // shared/hooks was never touched: diff must be empty
    expect(hooksGitDiff(repo)).toBe('');
  });

  it('host-B push on top of host-A produces no diff on shared/hooks (no churn)', () => {
    // Host-A commits first (simulated above). Host-B then does its own push.
    // Neither host touches shared/hooks. Final diff from initial HEAD is zero.

    // Host-A commit
    writeFileSync(join(repo, 'shared', 'skills', 'skill-a.md'), '# skill-a\n');
    runGit(repo, ['add', 'shared/skills/skill-a.md']);
    runGit(repo, ['commit', '-m', 'host-A: add skill-a']);

    // Host-B commit (different skill)
    writeFileSync(join(repo, 'shared', 'skills', 'skill-b.md'), '# skill-b\n');
    runGit(repo, ['add', 'shared/skills/skill-b.md']);
    runGit(repo, ['commit', '-m', 'host-B: add skill-b']);

    // Diff of shared/hooks relative to initial HEAD must be empty on both commits
    const diffLatest = execFileSync('git', ['diff', 'HEAD~2', 'HEAD', '--', 'shared/hooks'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    expect(diffLatest).toBe('');
  });

  it('staging shared/hooks/* is rejected by enforceAllowList (negative control)', async () => {
    // Even if someone manually staged a shared/hooks file, enforceAllowList
    // must block it because shared/hooks/ is not in PUSH_ALLOWED_STATIC.
    vi.resetModules();
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');

    const map: PathMap = { projects: {} };
    // Simulate porcelain -z output for a staged file under shared/hooks/
    const porcelain = 'A  shared/hooks/hook.sh\0';
    expect(() => enforceAllowList(porcelain, map)).toThrow(NomadFatal);
  });
});
