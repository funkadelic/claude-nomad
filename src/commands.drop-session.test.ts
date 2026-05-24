import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Integration tests for cmdDropSession. Each test sets up a real `git init`'d
// temp REPO_HOME (`<testHome>/claude-nomad/`) plus a temp `<testHome>/.claude/`
// host root and exercises the command end-to-end against the synthetic
// `shared/projects/*/<sid>.jsonl` fixtures. The seven cases mirror SPEC
// acceptance (a)..(d) plus the Pitfall 7 idempotency guard, the lock-
// contention skip (Pitfall 6), and the path-traversal defense at function
// entry (defense-in-depth even though nomad.ts validates argv too).

describe('cmdDropSession (real git temp repo)', () => {
  type ExitSpy = MockInstance<(code?: string | number | null) => never>;
  type ErrorSpy = MockInstance<(...args: unknown[]) => void>;
  type LogSpy = MockInstance<(...args: unknown[]) => void>;

  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;
  let lockPath: string;
  let exitSpy: ExitSpy;
  let errorSpy: ErrorSpy;
  let logSpy: LogSpy;

  /**
   * Initialize a real git repo at `repoUnderHome` so the unstage primitives
   * (`git restore --staged`, `git rm --cached`, `git ls-files --error-unmatch`)
   * have an index to mutate.
   */
  function initRepo(): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoUnderHome });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repoUnderHome,
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoUnderHome });
  }

  /**
   * Stage `shared/projects/<logical>/<sid>.jsonl` (creating dirs as needed)
   * with the given content. Returns the absolute path of the staged file.
   */
  function stageSession(logical: string, sid: string, content: string): string {
    const dir = join(sharedProjects, logical);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(path, content);
    const rel = `shared/projects/${logical}/${sid}.jsonl`;
    execFileSync('git', ['add', rel], { cwd: repoUnderHome });
    return path;
  }

  /**
   * Stage one nested entry under the sibling subagent directory
   * `shared/projects/<logical>/<sid>/<relName>` (creating parent dirs as
   * needed) with the given content. Mirrors `stageSession` but targets the
   * `<sid>/` directory tree (keyed by the same session id) rather than the
   * flat `<sid>.jsonl`. Returns the absolute path of the staged file.
   */
  function stageSessionDir(logical: string, sid: string, relName: string, content: string): string {
    const path = join(sharedProjects, logical, sid, relName);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    const rel = `shared/projects/${logical}/${sid}/${relName}`;
    execFileSync('git', ['add', rel], { cwd: repoUnderHome });
    return path;
  }

  /**
   * Read `git diff --cached --name-only` from the temp repo as a single
   * trimmed string. Useful to assert that a file is or is not in the staged
   * tree without depending on `git ls-files` quoting.
   */
  function diffCached(): string {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repoUnderHome,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  }

  /**
   * Stitch every recorded `console.error` call into a single newline-joined
   * string so substring assertions can match across multiple emits.
   */
  function errOutput(): string {
    return errorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-dropsession-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    initRepo();
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    // Suppress `process.stderr.write` output during the test (warn/fail
    // glyph output goes through console.error and is captured by errorSpy).
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./commands.drop-session.ts');
    process.exitCode = 0;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('removes a newly-staged session from `git diff --cached`', async () => {
    // SPEC acceptance (a), new-file case: the file is in the index but not in
    // HEAD (no commit yet). cmdDropSession must remove it via `git rm --cached`.
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    expect(diffCached()).toContain('shared/projects/foo/sid-A.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(diffCached()).not.toContain('shared/projects/foo/sid-A.jsonl');
    // The file may or may not remain on disk; for newly-staged the working
    // tree is left alone by `git rm --cached`. We don't assert either way.
    // Make sure no exit-1 path fired (idempotent successful drop is exit 0).
    expect(process.exitCode === 1).toBe(false);
  });

  it('removes a tracked-in-HEAD session and resets the working tree to HEAD', async () => {
    // SPEC acceptance (a), tracked-in-HEAD case: file is committed, then a
    // new version is staged on top. cmdDropSession must reset both index and
    // working tree to HEAD via `git restore --staged --worktree`.
    const path = stageSession('foo', 'sid-A', '{"v":"committed"}\n');
    execFileSync('git', ['commit', '-q', '-m', 'add sid-A'], { cwd: repoUnderHome });
    // Overwrite + restage so the file is tracked-in-HEAD AND has new staged content.
    writeFileSync(path, '{"v":"new-staged"}\n');
    execFileSync('git', ['add', 'shared/projects/foo/sid-A.jsonl'], { cwd: repoUnderHome });
    expect(diffCached()).toContain('shared/projects/foo/sid-A.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    // Index reset to HEAD: no staged changes.
    expect(diffCached()).toBe('');
    // Working tree reset to the committed version.
    expect(readFileSync(path, 'utf8')).toBe('{"v":"committed"}\n');
  });

  it('does NOT touch the local ~/.claude/projects/<encoded>/<id>.jsonl file', async () => {
    // SPEC acceptance (b): the local file under CLAUDE_HOME must be byte-
    // identical before and after the drop.
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    const localPath = join(localDir, 'sid-A.jsonl');
    const localMarker = '{"local":"content marker"}\n';
    writeFileSync(localPath, localMarker);

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf8')).toBe(localMarker);
  });

  it('is idempotent: a second invocation on the same id is a no-op exit 0 (Pitfall 7)', async () => {
    // SPEC acceptance (c) + Pitfall 7 guard. After the first drop the file is
    // not in the index at all; the second drop must skip silently rather than
    // call `git rm --cached` on an untracked path (which would fail).
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached()).not.toContain('shared/projects/foo/sid-A.jsonl');

    // Second invocation must NOT throw and must NOT set exitCode=1.
    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    // And no `✗` fail glyph was emitted on the second call.
    expect(errOutput()).not.toMatch(/✗/);
  });

  it('exits 1 with `✗ no staged session matches <id>` when no match exists and releases the lock', async () => {
    // SPEC acceptance (d): non-existent id. The no-match arm must throw
    // NomadFatal so the `finally { releaseLock }` runs; process.exit(1) on
    // that arm would terminate synchronously and leak the lockfile.
    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-X');
    expect(process.exitCode).toBe(1);
    expect(errOutput()).toMatch(/✗ +no staged session matches sid-X/);
    expect(errOutput()).not.toContain('FATAL');
    // Lock release on the throw path. The lockfile must NOT exist after the
    // call: this is the load-bearing assertion that distinguishes the
    // throw-and-unwind fix from the prior process.exit(1) leak.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when shared/projects/ is missing entirely', async () => {
    // The earlier no-match arm fires when shared/projects/ has at least one
    // logical but no jsonl matches the id. This test exercises the other
    // throw path: shared/projects/ does not exist at all. Both arms must
    // unwind via NomadFatal so `finally { releaseLock }` runs.
    rmSync(sharedProjects, { recursive: true, force: true });
    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-Y');
    expect(process.exitCode).toBe(1);
    expect(errOutput()).toMatch(/✗ +no staged session matches sid-Y/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('exits 0 on lock contention and emits `another nomad drop-session running, skipping`', async () => {
    // Pitfall 6 + matches the cmdPull/cmdPush lock-contention pattern. Hold
    // the lock manually (with this process's pid so the stale-pid recovery
    // path treats it as live), then invoke cmdDropSession. acquireLock
    // returns null inside the command, which triggers process.exit(0).
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    mkdirSync(join(testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(lockPath, String(process.pid));

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).toThrow('exit:0');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errOutput()).toContain('⚠︎ another nomad drop-session running, skipping');
    // The index was NOT mutated: the staged file is still there.
    expect(diffCached()).toContain('shared/projects/foo/sid-A.jsonl');
    // Used to verify no spurious unrelated log line fired before the skip.
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it('walks multiple logical dirs and only matches files that exist in each', async () => {
    // Exercise both directions of the per-logical existsSync check inside a
    // single cmdDropSession call: one logical contains <id>.jsonl, another
    // contains a different file. The loop iterates over both and only the
    // matching path is unstaged. Closes the line-58 branch-coverage gap.
    stageSession('matching', 'sid-A', '{"role":"user","content":"a"}\n');
    const otherDir = join(sharedProjects, 'not-matching');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'other-id.jsonl'), '{"role":"user","content":"other"}\n');
    execFileSync('git', ['add', '-A'], { cwd: repoUnderHome });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();
    const cached = diffCached();
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
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    // Read-only the entire .git directory so git rm --cached fails when it
    // tries to rewrite the index. The chmod is reverted in afterEach via
    // the testHome cleanup (rmSync recursive).
    chmodSync(join(repoUnderHome, '.git'), 0o555);
    try {
      const { cmdDropSession } = await import('./commands.drop-session.ts');
      expect(() => cmdDropSession('sid-A')).not.toThrow();
      expect(process.exitCode).toBe(1);
      const out = errOutput();
      expect(out).toMatch(/✗ +git failed to unstage/);
      expect(out).toContain('shared/projects/foo/sid-A.jsonl');
      // Lock must still be released even on the failure path.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      // Restore write perm so afterEach can rmSync the tree cleanly.
      chmodSync(join(repoUnderHome, '.git'), 0o755);
    }
  });

  it('throws NomadFatal `repo not cloned` when REPO_HOME is missing entirely', async () => {
    // Pre-flight guard at function entry: before lock acquisition, before
    // any walk, cmdDropSession checks that ~/claude-nomad/ exists. When the
    // user has installed the CLI elsewhere but never cloned to the canonical
    // REPO_HOME path, this surfaces a clear NomadFatal rather than letting
    // downstream readdirSync fail with a confusing ENOENT.
    rmSync(repoUnderHome, { recursive: true, force: true });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdDropSession('sid-A')).toThrow(NomadFatal);
    expect(() => cmdDropSession('sid-A')).toThrow(/repo not cloned/);
    // No lock should have been acquired (die fires before acquireLock).
    expect(existsSync(lockPath)).toBe(false);
  });

  it('treats `git ls-files` failures as "not in index" and logs "already absent" without throwing', async () => {
    // Cover isInIndex's catch branch (line 140): when `git ls-files` itself
    // fails (corrupt index, missing .git, EACCES on the index file), the
    // helper conservatively reports "not in index" so the idempotency guard
    // proceeds to the "already absent" log path instead of escalating to a
    // FATAL. Stage a session normally, then nuke .git so the index lookup
    // fails on the subsequent cmdDropSession call.
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    rmSync(join(repoUnderHome, '.git'), { recursive: true, force: true });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();
    const logged = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain('already absent from index');
    expect(process.exitCode).toBe(0);
  });

  it('cascades into the newly-staged subagent directory (Test A)', async () => {
    // Issue #110: dropping a session must also unstage the sibling subagent
    // directory `shared/projects/<logical>/<id>/...` keyed by the same id.
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    expect(diffCached()).toContain('shared/projects/foo/sid-A.jsonl');
    expect(diffCached()).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const cached = diffCached();
    expect(cached).not.toContain('shared/projects/foo/sid-A.jsonl');
    expect(cached).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');
    expect(process.exitCode === 1).toBe(false);
  });

  it('cascades a tracked-in-HEAD subagent file and resets the working tree (Test B)', async () => {
    // The cascade must classify a committed-then-restaged subagent entry as
    // tracked-in-HEAD and use `git restore --staged --worktree`.
    const path = stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"v":"committed"}\n');
    execFileSync('git', ['commit', '-q', '-m', 'add subagent'], { cwd: repoUnderHome });
    writeFileSync(path, '{"v":"new-staged"}\n');
    execFileSync('git', ['add', 'shared/projects/foo/sid-A/subagents/agent-1.jsonl'], {
      cwd: repoUnderHome,
    });
    expect(diffCached()).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(diffCached()).toBe('');
    expect(readFileSync(path, 'utf8')).toBe('{"v":"committed"}\n');
  });

  it('drops a dir-only session with no flat <id>.jsonl (Test C)', async () => {
    // A session that has only a subagent directory (no top-level <id>.jsonl)
    // must still be droppable, not a no-match exit 1.
    stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    expect(diffCached()).toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();

    expect(diffCached()).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');
    expect(process.exitCode === 1).toBe(false);
    expect(errOutput()).not.toMatch(/✗/);
  });

  it('is idempotent across the directory cascade on a second run (Test D)', async () => {
    stageSession('foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached()).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    expect(errOutput()).not.toMatch(/✗/);
  });

  it('is idempotent for a dir-only session on a second run (Test D2)', async () => {
    // Regression for the dir-only rerun gap: after the first drop, the
    // newly-staged subagent files remain on disk but leave the index, so a
    // second run finds the <id>/ dir present yet `git ls-files` empty. It must
    // be a no-op exit 0, not a `✗ no staged session matches` fatal.
    stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached()).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    expect(errOutput()).not.toMatch(/✗/);
  });

  it('does NOT touch the local subagent directory tree (Test E)', async () => {
    // The cascade operates only on REPO_HOME's git index; the local
    // ~/.claude/projects/<encoded>/<id>/subagents/... must be untouched.
    stageSessionDir('foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');
    const localDir = join(claudeProjects, '-tmp-foo', 'sid-A', 'subagents');
    mkdirSync(localDir, { recursive: true });
    const localPath = join(localDir, 'agent-1.jsonl');
    const localMarker = '{"local":"subagent marker"}\n';
    writeFileSync(localPath, localMarker);

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf8')).toBe(localMarker);
  });

  it('rejects invalid session ids at function entry with `✗ invalid session id`', async () => {
    // Defense-in-depth: nomad.ts already validates argv, but cmdDropSession
    // also rejects ids that contain `/`, `..`, empty string, or other
    // non-allowlist chars. Mirrors src/resume.ts.
    const { cmdDropSession } = await import('./commands.drop-session.ts');

    expect(() => cmdDropSession('../etc/passwd')).toThrow('exit:1');
    expect(errOutput()).toMatch(/✗ +invalid session id: \.\.\/etc\/passwd/);

    expect(() => cmdDropSession('foo/bar')).toThrow('exit:1');
    expect(errOutput()).toMatch(/✗ +invalid session id: foo\/bar/);

    expect(() => cmdDropSession('')).toThrow('exit:1');
    expect(errOutput()).toMatch(/✗ +invalid session id:/);

    // Stage a session whose id contains underscores+hyphens so we can prove
    // the allowlist permits them (no FATAL fires on the entry validator).
    stageSession('foo', 'sid_OK-with_underscore', '{"k":"v"}\n');
    expect(() => cmdDropSession('sid_OK-with_underscore')).not.toThrow();
    expect(diffCached()).not.toContain('sid_OK-with_underscore');
  });
});
