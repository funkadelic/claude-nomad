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
    expect(process.exitCode).not.toBe(1);
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
    expect(process.exitCode).not.toBe(1);
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
    expect(process.exitCode).not.toBe(1);
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

// ---------------------------------------------------------------------------
// cmdDropSession: id-validation guard boundary tests (L41 survivors)
// ---------------------------------------------------------------------------

describe('cmdDropSession (id-validation boundary, L41)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  it('rejects a 129-char id (> 128) and accepts a 128-char id (kills L41 EqualityOperator >= 128)', async () => {
    // L41 `id.length > 128` mutated to `>= 128` would reject a valid 128-char id.
    // Prove that exactly 128 chars is accepted and 129 chars is rejected.
    const id128 = 'a'.repeat(128);
    const id129 = 'a'.repeat(129);
    stageSession(env, 'foo', id128, '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    // 128-char id must be accepted (no exit:1 thrown).
    expect(() => cmdDropSession(id128)).not.toThrow();
    expect(diffCached(env)).not.toContain(id128);

    // 129-char id must be rejected.
    expect(() => cmdDropSession(id129)).toThrow('exit:1');
    expect(errOutput(env)).toMatch(/invalid session id/);
  });

  it('rejects an id with special chars (! # etc) while accepting all-alphanumeric (kills L41 LogicalOperator)', async () => {
    // L41 `id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)`
    // mutated with `&&` would require ALL conditions to reject. Prove that a
    // short id with invalid chars is still rejected when length checks would pass.
    const idValid = 'abc123';
    const idInvalid = 'abc!@#';
    stageSession(env, 'foo', idValid, '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    // Valid short alphanum id accepted.
    expect(() => cmdDropSession(idValid)).not.toThrow();

    // Invalid chars id rejected (length is 6, valid range -- only the regex fails).
    expect(() => cmdDropSession(idInvalid)).toThrow('exit:1');
    expect(errOutput(env)).toMatch(/invalid session id/);
  });
});

// ---------------------------------------------------------------------------
// cmdDropSession: collectMatches existsSync branches (L97/L101)
// ---------------------------------------------------------------------------

describe('cmdDropSession (collectMatches existsSync branches, L97/L101)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  it('does NOT include a session when no <id>.jsonl exists on disk (kills L97 ConditionalExpression true)', async () => {
    // L97 `if (existsSync(candidate))` forced to `true` would push every
    // candidate path even when the file does not exist, producing a spurious
    // match on a nonexistent path. Stage only sid-B so sid-A has no .jsonl.
    stageSession(env, 'foo', 'sid-B', '{"k":"v"}\n');
    const { cmdDropSession } = await import('./commands.drop-session.ts');

    // sid-A has no staged file: NomadFatal sets exitCode=1 and emits "no staged session".
    cmdDropSession('sid-A');
    expect(process.exitCode).toBe(1);
    expect(errOutput(env)).toMatch(/no staged session matches sid-A/);
    // sid-B's .jsonl should still be staged (not accidentally touched).
    expect(diffCached(env)).toContain('shared/projects/foo/sid-B.jsonl');
  });

  it('does NOT include a dir-only entry when it has no staged contents (kills L101 ConditionalExpression true)', async () => {
    // L101 `if (existsSync(dir) && statSync(dir).isDirectory())` forced to `true`
    // would always enter the dir branch. With no subagent dir present, the path
    // should not be added as a match. Only a flat .jsonl session present.
    stageSession(env, 'foo', 'sid-A', '{"k":"v"}\n');
    // No sid-B directory at all.
    const { cmdDropSession } = await import('./commands.drop-session.ts');

    // Dropping sid-B (which has no .jsonl or dir) should produce "no staged session matches".
    cmdDropSession('sid-B');
    expect(process.exitCode).toBe(1);
    expect(errOutput(env)).toMatch(/no staged session matches sid-B/);
    // sid-A's file should remain untouched.
    expect(diffCached(env)).toContain('shared/projects/foo/sid-A.jsonl');
  });
});

describe('cmdDropSession (scrub-remediation hint)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeDropSessionEnv();
  });

  afterEach(() => {
    teardownDropSessionEnv(env);
  });

  /** Stitch every recorded `console.log` call into one newline-joined string. */
  function logOutput(): string {
    return env.logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  /**
   * Write `path-map.json` into the temp REPO_HOME so `resolveLiveTranscript`
   * can reverse-map a dropped session to its live transcript path.
   */
  function writePathMap(body: unknown): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    writeFileSync(join(env.repoUnderHome, 'path-map.json'), text);
  }

  it('points at the exact live transcript when path-map resolves it for this host', async () => {
    // The unstage clears only the staged copy; the secret still lives in the
    // local transcript. With path-map mapping the logical to this host
    // (NOMAD_HOST=test-host), the hint resolves the live path precisely.
    writePathMap({ projects: { 'proj-x': { 'test-host': '/work/proj-x' } } });
    const liveDir = join(env.claudeProjects, '-work-proj-x'); // encodePath('/work/proj-x')
    mkdirSync(liveDir, { recursive: true });
    const livePath = join(liveDir, 'sid-LEAK.jsonl');
    writeFileSync(livePath, '{"k":"v"}\n');
    stageSession(env, 'proj-x', 'sid-LEAK', '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-LEAK');

    const logged = logOutput();
    expect(logged).toContain('local source still contains the secret');
    expect(logged).toContain(`nomad redact sid-LEAK`);
    expect(logged).toContain(`scrub ${livePath} manually`);
  });

  it('falls back to the generic template when no path-map exists', async () => {
    // No path-map.json at all: the live path cannot be resolved, so the hint
    // still fires with the generic ~/.claude/projects/<encoded>/<id> template.
    stageSession(env, 'foo', 'sid-A', '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const logged = logOutput();
    expect(logged).toContain('local source still contains the secret');
    expect(logged).toContain('nomad redact sid-A');
    expect(logged).toContain('scrub ~/.claude/projects/<encoded>/sid-A.jsonl manually');
  });

  it('falls back to the generic template when the session is not mapped to this host', async () => {
    // path-map exists but only maps the logical to a different host, so
    // hosts[test-host] is undefined and resolution falls through to generic.
    writePathMap({ projects: { foo: { 'other-host': '/work/foo' } } });
    stageSession(env, 'foo', 'sid-A', '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const logged = logOutput();
    expect(logged).toContain('local source still contains the secret');
    expect(logged).toContain('nomad redact sid-A');
    expect(logged).toContain('scrub ~/.claude/projects/<encoded>/sid-A.jsonl manually');
  });

  it('falls back to the generic template when the resolved live transcript is absent', async () => {
    // path-map resolves the logical to this host, but the live file does not
    // exist on disk (already scrubbed), so the existsSync guard rejects it.
    writePathMap({ projects: { 'proj-x': { 'test-host': '/work/proj-x' } } });
    stageSession(env, 'proj-x', 'sid-A', '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const logged = logOutput();
    expect(logged).toContain('local source still contains the secret');
    expect(logged).toContain('nomad redact sid-A');
    expect(logged).toContain('scrub ~/.claude/projects/<encoded>/sid-A.jsonl manually');
  });

  it('falls back to the generic template when path-map.json is malformed JSON', async () => {
    // A parse error inside resolveLiveTranscript degrades to the generic hint
    // rather than crashing the (already successful) drop.
    writePathMap('{ not valid json');
    stageSession(env, 'foo', 'sid-A', '{"k":"v"}\n');

    const { cmdDropSession } = await import('./commands.drop-session.ts');
    cmdDropSession('sid-A');

    const logged = logOutput();
    expect(logged).toContain('local source still contains the secret');
    expect(logged).toContain('nomad redact sid-A');
    expect(logged).toContain('scrub ~/.claude/projects/<encoded>/sid-A.jsonl manually');
    expect(process.exitCode).not.toBe(1);
  });
});
