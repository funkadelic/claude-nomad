import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Validation, entry-guard, idempotency, and lock-contention cases for
// cmdDropSession. The match-collection / unstage / subagent-cascade cases live
// in commands.drop-session.unstage.test.ts. Both suites load the SUT via
// `await import('./commands.drop-session.ts')` (the public symbol did not move)
// and share the temp-repo harness in commands.drop-session.test-helpers.ts.

describe('cmdDropSession (validation, idempotency, lock)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  it('rejects invalid session ids at function entry with `✗ invalid session id`', async () => {
    // Defense-in-depth: nomad.ts already validates argv, but cmdDropSession
    // also rejects ids that contain `/`, `..`, empty string, or other
    // non-allowlist chars. Mirrors src/resume.ts.
    const { cmdDropSession } = await import('./commands.drop-session.ts');

    expect(() => cmdDropSession('../etc/passwd')).toThrow('exit:1');
    expect(errOutput(env)).toMatch(/✗ +invalid session id: \.\.\/etc\/passwd/);

    expect(() => cmdDropSession('foo/bar')).toThrow('exit:1');
    expect(errOutput(env)).toMatch(/✗ +invalid session id: foo\/bar/);

    expect(() => cmdDropSession('')).toThrow('exit:1');
    expect(errOutput(env)).toMatch(/✗ +invalid session id:/);

    // Stage a session whose id contains underscores+hyphens so we can prove
    // the allowlist permits them (no FATAL fires on the entry validator).
    stageSession(env, 'foo', 'sid_OK-with_underscore', '{"k":"v"}\n');
    expect(() => cmdDropSession('sid_OK-with_underscore')).not.toThrow();
    expect(diffCached(env)).not.toContain('sid_OK-with_underscore');
  });

  it('throws NomadFatal `repo not cloned` when REPO_HOME is missing entirely', async () => {
    // Pre-flight guard at function entry: before lock acquisition, before
    // any walk, cmdDropSession checks that ~/claude-nomad/ exists. When the
    // user has installed the CLI elsewhere but never cloned to the canonical
    // REPO_HOME path, this surfaces a clear NomadFatal rather than letting
    // downstream readdirSync fail with a confusing ENOENT.
    rmSync(env.repoUnderHome, { recursive: true, force: true });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdDropSession('sid-A')).toThrow(NomadFatal);
    expect(() => cmdDropSession('sid-A')).toThrow(/repo not cloned/);
    // No lock should have been acquired (die fires before acquireLock).
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('is idempotent: a second invocation on the same id is a no-op exit 0 (Pitfall 7)', async () => {
    // SPEC acceptance (c) + Pitfall 7 guard. After the first drop the file is
    // not in the index at all; the second drop must skip silently rather than
    // call `git rm --cached` on an untracked path (which would fail).
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached(env)).not.toContain('shared/projects/foo/sid-A.jsonl');

    // Second invocation must NOT throw and must NOT set exitCode=1.
    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    // And no `✗` fail glyph was emitted on the second call.
    expect(errOutput(env)).not.toMatch(/✗/);
  });

  it('treats `git ls-files` failures as "not in index" and logs "already absent" without throwing', async () => {
    // Cover isInIndex's catch branch: when `git ls-files` itself fails
    // (corrupt index, missing .git, EACCES on the index file), the helper
    // conservatively reports "not in index" so the idempotency guard proceeds
    // to the "already absent" log path instead of escalating to a FATAL. Stage
    // a session normally, then nuke .git so the index lookup fails on the
    // subsequent cmdDropSession call.
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    rmSync(join(env.repoUnderHome, '.git'), { recursive: true, force: true });

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).not.toThrow();
    const logged = env.logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain('already absent from index');
    expect(process.exitCode).toBe(0);
  });

  it('is idempotent across the directory cascade on a second run (Test D)', async () => {
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    stageSessionDir(env, 'foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached(env)).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    expect(errOutput(env)).not.toMatch(/✗/);
  });

  it('is idempotent for a dir-only session on a second run (Test D2)', async () => {
    // Regression for the dir-only rerun gap: after the first drop, the
    // newly-staged subagent files remain on disk but leave the index, so a
    // second run finds the <id>/ dir present yet `git ls-files` empty. It must
    // be a no-op exit 0, not a `✗ no staged session matches` fatal.
    stageSessionDir(env, 'foo', 'sid-A', 'subagents/agent-1.jsonl', '{"agent":"1"}\n');

    const mod = await import('./commands.drop-session.ts');
    mod.cmdDropSession('sid-A');
    expect(diffCached(env)).not.toContain('shared/projects/foo/sid-A/subagents/agent-1.jsonl');

    expect(() => mod.cmdDropSession('sid-A')).not.toThrow();
    expect(process.exitCode === 1).toBe(false);
    expect(errOutput(env)).not.toMatch(/✗/);
  });

  it('exits 0 on lock contention and emits `another nomad drop-session running, skipping`', async () => {
    // Pitfall 6 + matches the cmdPull/cmdPush lock-contention pattern. Hold
    // the lock manually (with this process's pid so the stale-pid recovery
    // path treats it as live), then invoke cmdDropSession. acquireLock
    // returns null inside the command, which triggers process.exit(0).
    stageSession(env, 'foo', 'sid-A', '{"role":"user","content":"hi"}\n');
    mkdirSync(join(env.testHome, '.cache', 'claude-nomad'), { recursive: true });
    writeFileSync(env.lockPath, String(process.pid));

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    expect(() => cmdDropSession('sid-A')).toThrow('exit:0');
    expect(env.exitSpy).toHaveBeenCalledWith(0);
    expect(errOutput(env)).toContain('⚠︎ another nomad drop-session running, skipping');
    // The index was NOT mutated: the staged file is still there.
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A.jsonl');
    // Used to verify no spurious unrelated log line fired before the skip.
    expect(env.logSpy.mock.calls).toHaveLength(0);
  });
});
