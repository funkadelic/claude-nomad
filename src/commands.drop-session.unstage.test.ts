import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffCached,
  type Env,
  errOutput,
  makeDropSessionEnv,
  stageSession,
  teardownDropSessionEnv,
} from './commands.drop-session.test-helpers.ts';

// Match-collection and unstage cases for cmdDropSession (the flat `<id>.jsonl`
// path: newly-staged vs tracked-in-HEAD, multi-logical walk, no-match unwind,
// and the git-failure wrap). The subagent-directory cascade lives in
// commands.drop-session.cascade.test.ts; validation/idempotency/lock cases in
// commands.drop-session.test.ts. SUT path `./commands.drop-session.ts` unchanged.

describe('cmdDropSession (match collection + unstage)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  it('removes a newly-staged session from `git diff --cached`', async () => {
    // SPEC acceptance (a), new-file case: the file is in the index but not in
    // HEAD (no commit yet). cmdDropSession must remove it via `git rm --cached`.
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(diffCached(env)).not.toContain('shared/projects/foo/sid-A.jsonl');
    // The file may or may not remain on disk; for newly-staged the working
    // tree is left alone by `git rm --cached`. We don't assert either way.
    // Make sure no exit-1 path fired (idempotent successful drop is exit 0).
    expect(process.exitCode).not.toBe(1);
  });

  it('removes a tracked-in-HEAD session and resets the working tree to HEAD', async () => {
    // SPEC acceptance (a), tracked-in-HEAD case: file is committed, then a
    // new version is staged on top. cmdDropSession must reset both index and
    // working tree to HEAD via `git restore --staged --worktree`.
    const path = stageSession(env, 'foo', 'sid-A', '{"v":"committed"}\n');
    execFileSync('git', ['commit', '-q', '-m', 'add sid-A'], { cwd: env.repoUnderHome });
    // Overwrite + restage so the file is tracked-in-HEAD AND has new staged content.
    writeFileSync(path, '{"v":"new-staged"}\n');
    execFileSync('git', ['add', 'shared/projects/foo/sid-A.jsonl'], { cwd: env.repoUnderHome });
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    // Index reset to HEAD: no staged changes.
    expect(diffCached(env)).toBe('');
    // Working tree reset to the committed version.
    expect(readFileSync(path, 'utf8')).toBe('{"v":"committed"}\n');
  });

  it('does NOT touch the local ~/.claude/projects/<encoded>/<id>.jsonl file', async () => {
    // SPEC acceptance (b): the local file under CLAUDE_HOME must be byte-
    // identical before and after the drop.
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    const localDir = join(env.claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    const localPath = join(localDir, 'sid-A.jsonl');
    const localMarker = '{"local":"content marker"}\n';
    writeFileSync(localPath, localMarker);

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf8')).toBe(localMarker);
  });

  it('exits 1 with `✗ no staged session matches <id>` when no match exists and releases the lock', async () => {
    // SPEC acceptance (d): non-existent id. The no-match arm must throw
    // NomadFatal so the `finally { releaseLock }` runs; process.exit(1) on
    // that arm would terminate synchronously and leak the lockfile.
    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-X');
    expect(process.exitCode).toBe(1);
    expect(errOutput(env)).toMatch(/✗ +no staged session matches sid-X/);
    expect(errOutput(env)).not.toContain('FATAL');
    // Lock release on the throw path. The lockfile must NOT exist after the
    // call: this is the load-bearing assertion that distinguishes the
    // throw-and-unwind fix from the prior process.exit(1) leak.
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('releases the lock when shared/projects/ is missing entirely', async () => {
    // The earlier no-match arm fires when shared/projects/ has at least one
    // logical but no jsonl matches the id. This test exercises the other
    // throw path: shared/projects/ does not exist at all. Both arms must
    // unwind via NomadFatal so `finally { releaseLock }` runs.
    rmSync(env.sharedProjects, { recursive: true, force: true });
    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-Y');
    expect(process.exitCode).toBe(1);
    expect(errOutput(env)).toMatch(/✗ +no staged session matches sid-Y/);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('walks multiple logical dirs and only matches files that exist in each', async () => {
    // Exercise both directions of the per-logical existsSync check inside a
    // single cmdDropSession call: one logical contains <id>.jsonl, another
    // contains a different file. The loop iterates over both and only the
    // matching path is unstaged. Closes the per-logical branch-coverage gap.
    stageSession(env, 'matching', 'sid-A', '{"role":"user","content":"a"}\n');
    const otherDir = join(env.sharedProjects, 'not-matching');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'other-id.jsonl'), '{"role":"user","content":"other"}\n');
    execFileSync('git', ['add', '-A'], { cwd: env.repoUnderHome });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();
    const cached = diffCached(env);
    expect(cached).not.toContain('matching/sid-A.jsonl');
    expect(cached).toContain('not-matching/other-id.jsonl');
  });

  it('wraps `git rm --cached` failures as `✗ git failed to unstage`', async () => {
    // When git itself returns non-zero on the mutation step (e.g., EACCES on
    // .git/index from a read-only filesystem, a locked index, or a corrupt
    // tree), the failure must surface as a NomadFatal with the git stderr
    // included. Without the wrap added by this fix, the ExecException
    // bubbles past nomad.ts's NomadFatal-only dispatcher and the operator
    // sees a stack trace instead of `✗ ...`. Simulate the
    // EACCES path by chmod-ing .git to read-only after staging.
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    // Read-only the entire .git directory so git rm --cached fails when it
    // tries to rewrite the index. The chmod is reverted in afterEach via
    // the testHome cleanup (rmSync recursive).
    chmodSync(join(env.repoUnderHome, '.git'), 0o555);
    try {
      const { cmdDropSession } = await import('./commands.drop-session.ts');
      expect(() => cmdDropSession('sid-A')).not.toThrow();
      expect(process.exitCode).toBe(1);
      const out = errOutput(env);
      expect(out).toMatch(/✗ +git failed to unstage/);
      expect(out).toContain('shared/projects/foo/sid-A.jsonl');
      // Lock must still be released even on the failure path.
      expect(existsSync(env.lockPath)).toBe(false);
    } finally {
      // Restore write perm so afterEach can rmSync the tree cleanly.
      chmodSync(join(env.repoUnderHome, '.git'), 0o755);
    }
  });
});
