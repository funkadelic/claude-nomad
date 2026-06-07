import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

/** vi.spyOn(process, 'exit') return type shorthand. */
type ExitSpy = MockInstance<(code?: string | number | null) => never>;
/** vi.spyOn(console, 'error'|'log') return type shorthand. */
type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** Sandbox state for each cmdAdopt test. */
type Env = {
  originalHome: string | undefined;
  originalNomadRepo: string | undefined;
  testHome: string;
  repoHome: string;
  claudeHome: string;
  exitSpy: ExitSpy;
  errorSpy: LogSpy;
  logSpy: LogSpy;
};

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Initialize a real git repo at `repoHome` so `gitOrFatal(['add', ...])` has
 * an index to mutate.
 */
function initRepo(repoHome: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoHome });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoHome });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoHome });
}

/**
 * Create an isolated HOME sandbox for cmdAdopt tests: a temp HOME with a
 * `git init`'d nomad repo, a `shared/` tree, a `.claude/` host root, and
 * spies on `process.exit`, `console.error`, and `console.log`. Resets the
 * module cache so each test loads fresh.
 */
function makeAdoptEnv(): Env {
  const originalHome = process.env.HOME;
  const originalNomadRepo = process.env.NOMAD_REPO;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-adopt-test-'));

  const repoHome = join(testHome, 'claude-nomad');
  const claudeHome = join(testHome, '.claude');
  mkdirSync(join(repoHome, 'shared'), { recursive: true });
  mkdirSync(claudeHome, { recursive: true });

  // Write a minimal path-map.json (no sharedDirs by default; tests add them)
  writeFileSync(join(repoHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

  initRepo(repoHome);

  // Point config constants at temp dirs via env vars
  process.env.HOME = testHome;
  process.env.NOMAD_REPO = repoHome;

  vi.resetModules();

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${String(code)}`);
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  return {
    originalHome,
    originalNomadRepo,
    testHome,
    repoHome,
    claudeHome,
    exitSpy,
    errorSpy,
    logSpy,
  };
}

/**
 * Tear down a sandbox created by `makeAdoptEnv`: restore all mocks, env vars,
 * `process.exitCode`, and remove the temp HOME tree.
 */
function teardownAdoptEnv(env: Env): void {
  vi.restoreAllMocks();
  vi.doUnmock('./commands.adopt.ts');
  process.exitCode = 0;
  if (env.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.originalHome;
  if (env.originalNomadRepo === undefined) delete process.env.NOMAD_REPO;
  else process.env.NOMAD_REPO = env.originalNomadRepo;
  rmSync(env.testHome, { recursive: true, force: true });
}

/** Stitch every recorded `console.error` call into one newline-joined string. */
function errOutput(env: Env): string {
  return env.errorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/** Stitch every recorded `console.log` call into one newline-joined string. */
function logOutput(env: Env): string {
  return env.logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/** Read `git diff --cached --name-only` from the temp repo as a trimmed string. */
function diffCached(env: Env): string {
  return execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: env.repoHome,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/** Add a `sharedDirs` entry to the test path-map.json. */
function addSharedDir(env: Env, name: string): void {
  const mapPath = join(env.repoHome, 'path-map.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
    projects: unknown;
    sharedDirs?: string[];
  };
  map.sharedDirs = [...(map.sharedDirs ?? []), name];
  writeFileSync(mapPath, JSON.stringify(map) + '\n');
}

// ---------------------------------------------------------------------------
// Task 1: validation gate + precondition matrix
// ---------------------------------------------------------------------------

describe('cmdAdopt (precondition matrix)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    teardownAdoptEnv(env);
  });

  // V-04: invalid name is rejected before any mutation
  it('rejects an invalid name (path separator) before any mutation', async () => {
    const { cmdAdopt } = await import('./commands.adopt.ts');
    const namePath = join(env.claudeHome, '../evil');
    expect(() => cmdAdopt('../evil')).toThrow('exit:1');
    expect(errOutput(env)).toContain('../evil');
    // No git mutation
    expect(diffCached(env)).toBe('');
    // No filesystem change at claude home level
    expect(existsSync(namePath)).toBe(false);
  });

  // V-03 / D-03: unconfigured name -- not in SHARED_LINKS and not in sharedDirs
  it('rejects a valid name that is not a configured shared target', async () => {
    // "get-shit-done" passes isValidSharedDir but is not in SHARED_LINKS or sharedDirs
    const { cmdAdopt } = await import('./commands.adopt.ts');
    mkdirSync(join(env.claudeHome, 'get-shit-done'), { recursive: true });
    expect(() => cmdAdopt('get-shit-done')).toThrow('exit:1');
    const out = errOutput(env);
    expect(out).toContain('sharedDirs');
    expect(out).toContain('path-map.json');
    // Zero mutation
    expect(diffCached(env)).toBe('');
    expect(existsSync(join(env.repoHome, 'shared', 'get-shit-done'))).toBe(false);
  });

  // Membership coverage: SHARED_LINKS path -- "hooks" is a static SHARED_LINKS member
  it('proceeds past membership check when name is in SHARED_LINKS (hooks)', async () => {
    // hooks is in SHARED_LINKS; absent from CLAUDE_HOME -> "nothing to adopt" no-op
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('hooks')).not.toThrow();
    // The nothing-to-adopt branch: no error, no staging
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // Membership coverage: sharedDirs path -- exercises the || right branch
  it('proceeds past membership check when name is in sharedDirs', async () => {
    addSharedDir(env, 'my-custom-dir');
    // my-custom-dir is in sharedDirs; absent from CLAUDE_HOME -> "nothing to adopt" no-op
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-custom-dir')).not.toThrow();
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // readMapIfPresent fallback: a missing path-map.json yields an empty map and
  // a SHARED_LINKS name still passes the membership check (covers the absent branch)
  it('tolerates a missing path-map.json for a SHARED_LINKS name', async () => {
    rmSync(join(env.repoHome, 'path-map.json'));
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('hooks')).not.toThrow();
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // V-06: already a symlink -> no-op with "already adopted" message
  it('is a no-op when ~/.claude/<name> is already a symlink', async () => {
    addSharedDir(env, 'my-dir');
    const linkPath = join(env.claudeHome, 'my-dir');
    const targetPath = join(env.repoHome, 'shared', 'my-dir');
    mkdirSync(targetPath, { recursive: true });
    symlinkSync(targetPath, linkPath);

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).not.toThrow();
    const out = logOutput(env);
    expect(out).toContain('already adopted');
    // No git mutation
    expect(diffCached(env)).toBe('');
    // Source is still a symlink
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  // V-05: absent from CLAUDE_HOME -> no-op, exit 0 (nothing to adopt is not an error)
  it('is a no-op when ~/.claude/<name> does not exist', async () => {
    // Use "hooks" (SHARED_LINKS member) but don't create it under claudeHome
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('hooks')).not.toThrow();
    const out = logOutput(env);
    expect(out).toContain('nothing to adopt');
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // V-07: shared/<name> already exists -> clobber refusal, non-zero exit
  it('refuses when shared/<name> already exists (would clobber)', async () => {
    addSharedDir(env, 'my-dir');
    mkdirSync(join(env.claudeHome, 'my-dir'), { recursive: true });
    mkdirSync(join(env.repoHome, 'shared', 'my-dir'), { recursive: true });

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).toThrow('exit:1');
    const out = errOutput(env);
    expect(out).toContain('would clobber');
    expect(diffCached(env)).toBe('');
  });

  // V-07 (dangling target): a broken symlink at shared/<name> must still be
  // refused. existsSync follows links and reports false for a dangling link,
  // so the clobber guard uses an lstat-based check; otherwise cpSync would
  // throw an opaque non-NomadFatal error on the dangling destination.
  it('refuses when shared/<name> is a dangling symlink (would clobber)', async () => {
    addSharedDir(env, 'my-dir');
    mkdirSync(join(env.claudeHome, 'my-dir'), { recursive: true });
    mkdirSync(join(env.repoHome, 'shared'), { recursive: true });
    symlinkSync(
      join(env.repoHome, 'shared', 'nonexistent'),
      join(env.repoHome, 'shared', 'my-dir'),
    );

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).toThrow('exit:1');
    const out = errOutput(env);
    expect(out).toContain('would clobber');
    expect(diffCached(env)).toBe('');
  });

  // Verify lstatSync is used: a real dir should NOT take the already-adopted branch
  it('does not take the already-adopted branch for a real directory', async () => {
    addSharedDir(env, 'real-dir');
    mkdirSync(join(env.claudeHome, 'real-dir'), { recursive: true });

    const { cmdAdopt } = await import('./commands.adopt.ts');
    // No shared target yet -- should reach the happy-path move, not the symlink branch
    expect(() => cmdAdopt('real-dir')).not.toThrow();
    // The move ran (not the symlink branch): source is now a symlink
    const linkPath = join(env.claudeHome, 'real-dir');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(logOutput(env)).not.toContain('already adopted');
  });
});

// ---------------------------------------------------------------------------
// Task 2: move sequence + dry-run + ordering
// ---------------------------------------------------------------------------

describe('cmdAdopt (happy path and move sequence)', () => {
  let env: Env;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    teardownAdoptEnv(env);
  });

  // V-01: happy path moves content, creates symlink, stages, prints hint
  it('happy path: moves dir, creates symlink at source, stages shared/<name>', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(linkPath, 'config.json'), '{"key":"value"}\n');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');

    // shared/<name> contains the original files
    expect(existsSync(join(sharedTarget, 'tool.sh'))).toBe(true);
    expect(existsSync(join(sharedTarget, 'config.json'))).toBe(true);
    expect(readFileSync(join(sharedTarget, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');

    // source removed then symlink recreated
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // gitOrFatal called with exactly ['add', '--', 'shared/my-tools']
    expect(diffCached(env)).toContain('shared/my-tools');

    // hint printed verbatim
    const out = logOutput(env);
    expect(out).toContain('nomad push');
    expect(out).toContain('my-tools');
  });

  // V-01 (exact literal): ADOPT_PUSH_HINT exported and printed verbatim
  it('prints the exact ADOPT_PUSH_HINT literal', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    const mod = await import('./commands.adopt.ts');
    expect(() => mod.cmdAdopt('my-tools')).not.toThrow();

    const out = logOutput(env);
    expect(out).toContain(mod.ADOPT_PUSH_HINT);
  });

  // V-07 / ordering: copy completes before source removal -- verified by observing
  // that shared/<name> is fully populated and the source is removed in the final state
  it('ordering: shared copy is fully populated before source is removed', async () => {
    // We verify the copy-before-remove ordering invariant by:
    // 1. Running cmdAdopt on a dir with nested content
    // 2. Asserting shared/<name> has full content (proves cpSync ran)
    // 3. Asserting source is gone (proves rmSync ran after cpSync)
    // The implementation guarantees the order because rmSync follows cpSync in source;
    // if cpSync threw (ENOSPC, permission error), rmSync would never execute.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    const subDir = join(linkPath, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(linkPath, 'root.txt'), 'root\n');
    writeFileSync(join(subDir, 'nested.txt'), 'nested\n');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');

    // shared copy is fully populated (proves cpSync completed)
    expect(existsSync(join(sharedTarget, 'root.txt'))).toBe(true);
    expect(existsSync(join(sharedTarget, 'sub', 'nested.txt'))).toBe(true);

    // source is gone (proves rmSync ran AFTER cpSync completed)
    // The symlink at linkPath exists, but the real dir is gone
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // The real directory content is now under sharedTarget
    expect(readFileSync(join(sharedTarget, 'root.txt'), 'utf8')).toBe('root\n');
  });

  // V-08: dry-run is a true no-op
  it('dry-run: zero fs writes, zero git mutations, prints would-do lines', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools', { dryRun: true })).not.toThrow();

    // Source untouched
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);

    // shared/<name> not created
    expect(existsSync(join(env.repoHome, 'shared', 'my-tools'))).toBe(false);

    // No git staging
    expect(diffCached(env)).toBe('');

    // Planned action lines printed
    const out = logOutput(env);
    expect(out).toContain('would backup');
    expect(out).toContain('would move');
    expect(out).toContain('would stage');
  });

  // V-09 / D-03: path-map.json is not written during adopt
  it('does not create or modify path-map.json during adopt', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    const mapPath = join(env.repoHome, 'path-map.json');
    const mapBefore = readFileSync(mapPath, 'utf8');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const mapAfter = readFileSync(mapPath, 'utf8');
    expect(mapAfter).toBe(mapBefore);
  });

  // V-08 (content integrity): nested files survive the move byte-for-byte
  it('content integrity: nested files survive the move byte-for-byte', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    const subDir = join(linkPath, 'subdir');
    mkdirSync(subDir, { recursive: true });
    const content = 'line1\nline2\n';
    writeFileSync(join(subDir, 'nested.txt'), content);

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const sharedNested = join(env.repoHome, 'shared', 'my-tools', 'subdir', 'nested.txt');
    expect(existsSync(sharedNested)).toBe(true);
    expect(readFileSync(sharedNested, 'utf8')).toBe(content);
  });

  // gitOrFatal called with exactly ['add', '--', 'shared/<name>'] -- no git add -A
  it('stages with gitOrFatal(["add", "--", "shared/<name>"]) and not git add -A', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    // Only shared/my-tools staged; no other entries
    const staged = diffCached(env);
    expect(staged).toContain('shared/my-tools/file.txt');
    // Confirm no other unexpected path got staged
    const lines = staged.split('\n').filter(Boolean);
    expect(lines.every((l) => l.startsWith('shared/my-tools/'))).toBe(true);
  });

  // isValidAdoptName: invalid name in sharedDirs must still be rejected
  it('rejects a path-traversal name even when manually written into sharedDirs', async () => {
    // This can only happen if the user hand-edits path-map.json to contain an
    // unsafe name. cmdAdopt validates the name before checking membership, so the
    // invalid name must still be rejected at the isValidAdoptName gate.
    // Kills L73 ConditionalExpression -> true mutation (which would skip the name
    // validation entirely and accept any name, including path traversals).
    const mapPath = join(env.repoHome, 'path-map.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
      projects: unknown;
      sharedDirs?: string[];
    };
    // Directly insert an invalid entry bypassing isValidSharedDir
    map.sharedDirs = ['../evil'];
    writeFileSync(mapPath, JSON.stringify(map) + '\n');

    const { cmdAdopt } = await import('./commands.adopt.ts');
    // Invalid name must be rejected before membership is checked
    expect(() => cmdAdopt('../evil')).toThrow('exit:1');
    expect(errOutput(env)).toContain('../evil');
    // No filesystem mutation
    expect(diffCached(env)).toBe('');
  });

  // readMapIfPresent fallback: absent path-map.json returns { projects: {} }
  // Kills L44 ObjectLiteral -> {} mutation (would return an empty object with no
  // 'projects' key, causing Object.entries(map.projects) to throw in callers).
  it('readMapIfPresent fallback has a projects key when path-map.json is absent', async () => {
    rmSync(join(env.repoHome, 'path-map.json'));
    // Use a SHARED_LINKS name so it reaches isConfiguredTarget without name-validation fail.
    // hooks is in SHARED_LINKS, so even with empty sharedDirs it passes membership.
    const { cmdAdopt } = await import('./commands.adopt.ts');
    // Should not throw -- the fallback { projects: {} } means hooks is found in SHARED_LINKS.
    // If fallback was {} (no projects key), isConfiguredTarget would crash.
    expect(() => cmdAdopt('hooks')).not.toThrow();
    expect(errOutput(env)).toBe('');
  });
});
