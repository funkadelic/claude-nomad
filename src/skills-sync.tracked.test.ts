import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trackedRootSkillsAt } from './skills-sync.tracked.ts';

/**
 * Run a git command with an explicit cwd; throws on non-zero exit.
 */
function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Capture trimmed stdout of a git command.
 */
function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

describe('trackedRootSkillsAt', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nomad-tracked-skills-'));
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.invalid'], repoDir);
    git(['config', 'user.name', 'test'], repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the top-level basenames tracked under shared/skills/ at a ref', () => {
    mkdirSync(join(repoDir, 'shared', 'skills', 'team-skill'), { recursive: true });
    writeFileSync(join(repoDir, 'shared', 'skills', 'team-skill', 'SKILL.md'), '# team\n');
    mkdirSync(join(repoDir, 'shared', 'skills', 'another-skill'), { recursive: true });
    writeFileSync(join(repoDir, 'shared', 'skills', 'another-skill', 'SKILL.md'), '# another\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add skills'], repoDir);
    const ref = gitOut(['rev-parse', 'HEAD'], repoDir);

    const tracked = trackedRootSkillsAt(ref, repoDir);

    expect([...tracked].sort()).toEqual(['another-skill', 'team-skill']);
  });

  it('does not recurse into nested files (top-level granularity only)', () => {
    mkdirSync(join(repoDir, 'shared', 'skills', 'team-skill', 'nested'), { recursive: true });
    writeFileSync(join(repoDir, 'shared', 'skills', 'team-skill', 'nested', 'deep.md'), '# deep\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add nested skill file'], repoDir);
    const ref = gitOut(['rev-parse', 'HEAD'], repoDir);

    const tracked = trackedRootSkillsAt(ref, repoDir);

    expect([...tracked]).toEqual(['team-skill']);
  });

  it('returns an empty Set when the ref has no shared/skills/ path', () => {
    writeFileSync(join(repoDir, 'README.md'), '# readme\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'no skills dir'], repoDir);
    const ref = gitOut(['rev-parse', 'HEAD'], repoDir);

    const tracked = trackedRootSkillsAt(ref, repoDir);

    expect(tracked.size).toBe(0);
  });

  it('returns an empty Set when the git call throws (fail-safe)', () => {
    const badRef = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const tracked = trackedRootSkillsAt(badRef, repoDir);

    expect(tracked.size).toBe(0);
  });

  it('returns an empty Set when repo is not a git checkout at all (fail-safe)', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'nomad-not-a-repo-'));
    try {
      const tracked = trackedRootSkillsAt('HEAD', notARepo);
      expect(tracked.size).toBe(0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
