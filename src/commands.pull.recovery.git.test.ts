import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitCapture, parsePorcelainZ } from './commands.pull.recovery.git.ts';
import { classifyTouched } from './commands.pull.recovery.ts';

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

  it('reports the destination-to-source pairing, which the flat arrays lose', () => {
    // A consumer that acts on the destination alone has to be able to find the
    // source: the same index operation staged its deletion, and undoing only
    // half of a rename leaves that deletion staged.
    const raw = 'R  shared/commands/tasks/foo.md\0shared/commands/foo.md\0C  copy.ts\0src/a.ts\0';
    expect(parsePorcelainZ(raw).renameSources).toEqual({
      'shared/commands/tasks/foo.md': 'shared/commands/foo.md',
      'copy.ts': 'src/a.ts',
    });
  });

  it('tolerates a rename record missing its source field', () => {
    // Truncated payload: R record whose trailing source field is empty.
    const raw = 'R  tool.ts\0';
    const { tracked, renameSources } = parsePorcelainZ(raw);
    expect(tracked).toEqual(['tool.ts']);
    expect(renameSources).toEqual({});
  });

  it('partitions plain modified and untracked records', () => {
    const raw = ' M src/a.ts\0?? scratch.txt\0';
    const { tracked, untracked, renameSources } = parsePorcelainZ(raw);
    expect(tracked).toEqual(['src/a.ts']);
    expect(untracked).toEqual(['scratch.txt']);
    expect(renameSources).toEqual({});
  });

  it('returns empty arrays for empty input', () => {
    expect(parsePorcelainZ('')).toEqual({ tracked: [], untracked: [], renameSources: {} });
  });
});
