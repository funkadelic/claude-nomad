import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffCached,
  type Env,
  errOutput,
  makeDropSessionEnv,
  stageSession,
  stageSessionDir,
  teardownDropSessionEnv,
} from './commands.drop-session.test-helpers.ts';

// Subagent-directory cascade cases for cmdDropSession (Issue #110): dropping a
// session must also unstage the sibling `shared/projects/<logical>/<id>/...`
// tree keyed by the same id. The flat-jsonl match/unstage cases live in
// commands.drop-session.unstage.test.ts; validation/idempotency/lock in
// commands.drop-session.test.ts. SUT path `./commands.drop-session.ts` unchanged.

describe('cmdDropSession (subagent directory cascade)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  it('cascades into the newly-staged subagent directory (Test A)', async () => {
    // Issue #110: dropping a session must also unstage the sibling subagent
    // directory `shared/projects/<logical>/<id>/...` keyed by the same id.
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    stageSessionDir(env, 'foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A.jsonl');
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const cached = diffCached(env);
    expect(cached).not.toContain('shared/projects/foo/sid-A.jsonl');
    expect(cached).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');
    expect(process.exitCode).not.toBe(1);
  });

  it('cascades a tracked-in-HEAD subagent file and resets the working tree (Test B)', async () => {
    // The cascade must classify a committed-then-restaged subagent entry as
    // tracked-in-HEAD and use `git restore --staged --worktree`.
    const path = stageSessionDir(
      env,
      'foo',
      'sid-A',
      'subagents/agent-1.jsonl',
      '{"v":"committed"}\n',
    );
    execFileSync('git', ['commit', '-q', '-m', 'add subagent'], { cwd: env.repoUnderHome });
    writeFileSync(path, '{"v":"new-staged"}\n');
    execFileSync('git', ['add', 'shared/projects/foo/sid-A/subagents/agent-1.jsonl'], {
      cwd: env.repoUnderHome,
    });
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(diffCached(env)).toBe('');
    expect(readFileSync(path, 'utf8')).toBe('{"v":"committed"}\n');
  });

  it('drops a dir-only session with no flat <id>.jsonl (Test C)', async () => {
    // A session that has only a subagent directory (no top-level <id>.jsonl)
    // must still be droppable, not a no-match exit 1.
    stageSessionDir(env, 'foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();

    expect(diffCached(env)).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');
    expect(process.exitCode).not.toBe(1);
    expect(errOutput(env)).not.toMatch(/✗/);
  });

  it('does NOT touch the local subagent directory tree (Test E)', async () => {
    // The cascade operates only on REPO_HOME's git index; the local
    // ~/.claude/projects/<encoded>/<id>/subagents/... must be untouched.
    stageSessionDir(env, 'foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    const localDir = join(env.claudeProjects, '-tmp-foo', 'sid-A', 'subagents');
    mkdirSync(localDir, { recursive: true });
    const localPath = join(localDir, 'agent-1.jsonl');
    const localMarker = '{"local":"subagent marker"}\n';
    writeFileSync(localPath, localMarker);

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf8')).toBe(localMarker);
  });
});
