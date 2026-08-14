import { execFileSync } from 'node:child_process';
import type * as fsModule from 'node:fs';
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

import { EXIT } from './exit-codes.ts';
import type * as linksModule from './links.ts';
import { stubPlatform } from './test-helpers.platform.ts';
import type * as utilsModule from './utils.ts';
import type * as utilsFsModule from './utils.fs.ts';

// Posix-only assertions (symlink creation, clobber-refusal wording) below
// assume the process is genuinely running on a non-win32 host. On a real
// win32 runner cmdAdopt takes the copy-back branch for real (process.platform
// is not mocked in these cases), so those tests are skipped there; the win32
// behavior is covered separately by the "cmdAdopt win32 copy-back branch"
// describe block, which explicitly overrides process.platform.
const isWin = process.platform === 'win32';

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

  // An invalid name is rejected before any mutation
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

  // Unconfigured name -- not in SHARED_LINKS and not in sharedDirs
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

  // Membership coverage: SHARED_LINKS path -- "commands" is a static SHARED_LINKS member
  it('proceeds past membership check when name is in SHARED_LINKS (commands)', async () => {
    // commands is in SHARED_LINKS; absent from CLAUDE_HOME -> "nothing to adopt" no-op
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('commands')).not.toThrow();
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

  // A string sharedDirs turned the membership gate into a substring test, so
  // sharedDirs "my-custom-dir" answered yes for "custom". The accessor drops a
  // non-array whole, which must refuse the substring AND not throw a raw
  // TypeError (that is not a NomadFatal, so it would write a crash report).
  it.each(['my-custom-dir', 42, null])(
    'refuses a substring match and does not throw when sharedDirs is %p',
    async (bad) => {
      const mapPath = join(env.repoHome, 'path-map.json');
      writeFileSync(mapPath, JSON.stringify({ projects: {}, sharedDirs: bad }) + '\n');
      const { cmdAdopt } = await import('./commands.adopt.ts');
      expect(() => cmdAdopt('custom')).toThrow();
      // The friendly refusal, which only the guarded path can produce. A bare
      // toThrow() would also pass against the old code, where a non-array threw
      // a raw TypeError before reaching any message at all.
      expect(errOutput(env)).toContain('sharedDirs');
      expect(diffCached(env)).not.toContain('custom');
    },
  );

  // readMapIfPresent fallback: a missing path-map.json yields an empty map and
  // a SHARED_LINKS name still passes the membership check (covers the absent branch)
  it('tolerates a missing path-map.json for a SHARED_LINKS name', async () => {
    rmSync(join(env.repoHome, 'path-map.json'));
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('commands')).not.toThrow();
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // B7: hooks and agents are now in RESERVED_SHARED (gsd-owned); isValidAdoptName
  // rejects them before membership is even checked.
  it('rejects "hooks" as an invalid adopt name (B7: blocked by RESERVED_SHARED)', async () => {
    mkdirSync(join(env.claudeHome, 'hooks'), { recursive: true });
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('hooks')).toThrow('exit:1');
    expect(errOutput(env)).toContain('invalid name');
    expect(diffCached(env)).toBe('');
  });

  it('rejects "agents" as an invalid adopt name (B7: blocked by RESERVED_SHARED)', async () => {
    mkdirSync(join(env.claudeHome, 'agents'), { recursive: true });
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('agents')).toThrow('exit:1');
    expect(errOutput(env)).toContain('invalid name');
    expect(diffCached(env)).toBe('');
  });

  it('rejects "skills" as an invalid adopt name (copy-synced, blocked by RESERVED_SHARED)', async () => {
    mkdirSync(join(env.claudeHome, 'skills'), { recursive: true });
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('skills')).toThrow('exit:1');
    expect(errOutput(env)).toContain('invalid name');
    expect(diffCached(env)).toBe('');
  });

  // Credential-shaped names are a hard NomadFatal, ahead of the membership
  // and mutation paths, even when the user configured and materialized the
  // name themselves.
  it('hard-fails cmdAdopt(".env") with a NomadFatal naming the reason, and mutates nothing', async () => {
    addSharedDir(env, '.env');
    writeFileSync(join(env.claudeHome, '.env'), 'SECRET=1\n');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      cmdAdopt('.env');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal.message).toContain('.env');
    expect(fatal.message).toContain('credential-shaped');
    expect(fatal.code).toBe(EXIT.GENERIC_FAILURE);

    expect(diffCached(env)).toBe('');
    expect(existsSync(join(env.repoHome, 'shared', '.env'))).toBe(false);
  });

  it('hard-fails cmdAdopt("id_rsa") with a NomadFatal naming the reason', async () => {
    addSharedDir(env, 'id_rsa');
    writeFileSync(join(env.claudeHome, 'id_rsa'), 'fake-key\n');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      cmdAdopt('id_rsa');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const fatal = caught as InstanceType<typeof NomadFatal>;
    expect(fatal.message).toContain('id_rsa');
    expect(fatal.message).toContain('credential-shaped');
    expect(diffCached(env)).toBe('');
  });

  // Already a symlink -> no-op with "already adopted" message
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

  // Absent from CLAUDE_HOME -> no-op, exit 0 (nothing to adopt is not an error)
  it('is a no-op when ~/.claude/<name> does not exist', async () => {
    // Use "commands" (SHARED_LINKS member) but don't create it under claudeHome
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('commands')).not.toThrow();
    const out = logOutput(env);
    expect(out).toContain('nothing to adopt');
    expect(diffCached(env)).toBe('');
    expect(errOutput(env)).toBe('');
  });

  // shared/<name> already exists -> clobber refusal, non-zero exit
  it.skipIf(isWin)('refuses when shared/<name> already exists (would clobber)', async () => {
    addSharedDir(env, 'my-dir');
    mkdirSync(join(env.claudeHome, 'my-dir'), { recursive: true });
    mkdirSync(join(env.repoHome, 'shared', 'my-dir'), { recursive: true });

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).toThrow('exit:1');
    const out = errOutput(env);
    expect(out).toContain('would clobber');
    expect(diffCached(env)).toBe('');
  });

  // Dangling target: a broken symlink at shared/<name> must still be
  // refused. existsSync follows links and reports false for a dangling link,
  // so the clobber guard uses an lstat-based check; otherwise cpSync would
  // throw an opaque non-NomadFatal error on the dangling destination.
  it.skipIf(isWin)('refuses when shared/<name> is a dangling symlink (would clobber)', async () => {
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
  it.skipIf(isWin)('does not take the already-adopted branch for a real directory', async () => {
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

  // Happy path moves content, creates symlink, stages, prints hint
  it.skipIf(isWin)(
    'happy path: moves dir, creates symlink at source, stages shared/<name>',
    async () => {
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
    },
  );

  // Exact literal: ADOPT_PUSH_HINT exported and printed verbatim
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

  // Ordering: copy completes before source removal -- verified by observing
  // that shared/<name> is fully populated and the source is removed in the final state
  it.skipIf(isWin)(
    'ordering: shared copy is fully populated before source is removed',
    async () => {
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
    },
  );

  // Dry-run is a true no-op
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

  // path-map.json is not written during adopt
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

  // Content integrity: nested files survive the move byte-for-byte
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
    // commands is in SHARED_LINKS, so even with empty sharedDirs it passes membership.
    const { cmdAdopt } = await import('./commands.adopt.ts');
    // Should not throw -- the fallback { projects: {} } means commands is found in SHARED_LINKS.
    // If fallback was {} (no projects key), isConfiguredTarget would crash.
    expect(() => cmdAdopt('commands')).not.toThrow();
    expect(errOutput(env)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// win32 copy-back branch (no unprivileged symlink support)
// ---------------------------------------------------------------------------

describe('cmdAdopt win32 copy-back branch', () => {
  let env: Env;
  const realPlatform = process.platform;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    teardownAdoptEnv(env);
  });

  it('win32: leaves ~/.claude/<name> as a real copy (not a symlink) and stages shared/<name>', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');
    // shared/<name> contains the original files
    expect(existsSync(join(sharedTarget, 'tool.sh'))).toBe(true);
    expect(readFileSync(join(sharedTarget, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');

    // linkPath is a real copy, NOT a symlink
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(linkPath, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');

    // staged
    expect(diffCached(env)).toContain('shared/my-tools');
  });

  it('win32: does not call ensureSymlink (no symlink created at any point)', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    // The precondition matrix's "already a symlink" branch never applied
    // (source was real), and the win32 branch never created one either.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
  });

  it('win32 dry-run: reports a copy-back plan (not a symlink relink) and mutates nothing', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools', { dryRun: true })).not.toThrow();

    const out = logOutput(env);
    expect(out).toContain('would copy back');
    expect(out).not.toContain('would relink');

    // Zero mutation
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(existsSync(join(env.repoHome, 'shared', 'my-tools'))).toBe(false);
    expect(diffCached(env)).toBe('');
  });

  it('win32: re-running adopt on an already-adopted real copy returns 0 with a success message', async () => {
    // shared/<name> already exists (a prior adopt already ran) and linkPath is
    // a real (non-symlink) copy -- the win32 healthy state. Re-running adopt
    // must short-circuit before the clobber guard: no process.exit(1), no fs
    // mutation, no git staging, just a success message.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    mkdirSync(sharedTarget, { recursive: true });
    writeFileSync(join(sharedTarget, 'tool.sh'), '#!/bin/sh\necho hi\n');

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();
    expect(env.exitSpy).not.toHaveBeenCalled();

    const out = logOutput(env);
    expect(out).toContain('already adopted');
    expect(out).toContain('win32');

    // Zero mutation: linkPath still a real copy, no git staging
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(diffCached(env)).toBe('');
  });

  it('win32: a genuinely un-adopted name (no shared/<name> yet) still runs the normal move', async () => {
    // shared/<name> absent -- the already-adopted short-circuit must NOT fire,
    // and the normal copy-back move must still run.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'file.txt'), 'content\n');

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-tools')).not.toThrow();

    const out = logOutput(env);
    expect(out).not.toContain('already adopted');
    expect(diffCached(env)).toContain('shared/my-tools');
  });

  it('win32: a real symlink is reported as a symlink, not as the copy-sync state', async () => {
    // Both conditions hold at once on a win32 host with Developer Mode, or one
    // whose install predates the copy-sync model: linkPath is a symlink AND
    // shared/<name> exists. The symlink is the more specific state, so the
    // copy-sync message would name the wrong mechanism. Pinned with the
    // platform stubbed because the real-win32 runner is the only other place
    // this ordering shows up.
    addSharedDir(env, 'my-dir');
    const linkPath = join(env.claudeHome, 'my-dir');
    const targetPath = join(env.repoHome, 'shared', 'my-dir');
    mkdirSync(targetPath, { recursive: true });
    symlinkSync(targetPath, linkPath);

    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).not.toThrow();

    const out = logOutput(env);
    expect(out).toContain('already adopted (already a symlink)');
    expect(out).not.toContain('win32 copy-sync');
    expect(diffCached(env)).toBe('');
  });

  it('non-win32 (posix): the already-symlink branch is unchanged, not the win32 short-circuit', async () => {
    // posix: an already-symlinked linkPath takes the existing posix
    // already-adopted branch, never the win32-only message.
    addSharedDir(env, 'my-dir');
    const linkPath = join(env.claudeHome, 'my-dir');
    const targetPath = join(env.repoHome, 'shared', 'my-dir');
    mkdirSync(targetPath, { recursive: true });
    symlinkSync(targetPath, linkPath);

    const { cmdAdopt } = await import('./commands.adopt.ts');
    expect(() => cmdAdopt('my-dir')).not.toThrow();
    const out = logOutput(env);
    expect(out).toContain('already adopted (already a symlink)');
    expect(out).not.toContain('win32 copy-sync');
    expect(diffCached(env)).toBe('');
  });

  it.skipIf(isWin)(
    'non-win32: dry-run still reports a symlink relink plan (posix wording unchanged)',
    async () => {
      addSharedDir(env, 'my-tools');
      const linkPath = join(env.claudeHome, 'my-tools');
      mkdirSync(linkPath, { recursive: true });
      writeFileSync(join(linkPath, 'file.txt'), 'content\n');

      // No setPlatform call: exercises whatever this dev/CI host actually is
      // (posix), proving the win32 wording above is genuinely gated.
      const { cmdAdopt } = await import('./commands.adopt.ts');
      expect(() => cmdAdopt('my-tools', { dryRun: true })).not.toThrow();

      const out = logOutput(env);
      expect(out).toContain('would relink');
      expect(out).not.toContain('would copy back');
    },
  );
});

// ---------------------------------------------------------------------------
// Containment bound behind the partial-copy cleanup
// ---------------------------------------------------------------------------

describe('isDirectChildOf', () => {
  // Asserted directly because the guard it backs is unreachable through
  // cmdAdopt: an invalid name is rejected before any path is built from it,
  // so a test routed through the command could not tell a working bound from
  // an inverted one.
  it('accepts a direct child', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude', '/home/u/.claude/commands')).toBe(true);
  });

  it('accepts a direct child when the root carries a trailing separator', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude/', '/home/u/.claude/commands')).toBe(true);
  });

  it('rejects the root itself', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude', '/home/u/.claude')).toBe(false);
  });

  it('rejects a nested grandchild, not just an escape', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude', '/home/u/.claude/commands/nested')).toBe(false);
  });

  it('rejects a traversal that climbs out', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude', '/home/u/.claude/../.ssh/id_rsa')).toBe(false);
  });

  it('rejects a sibling whose name merely starts with the root', async () => {
    const { isDirectChildOf } = await import('./commands.adopt.ts');
    expect(isDirectChildOf('/home/u/.claude', '/home/u/.claude-evil/x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// win32 copy-back failure (locked or permission-denied destination)
// ---------------------------------------------------------------------------

/**
 * A genuine OS-level Windows lock cannot be provoked from vitest (Node opens
 * with full sharing by default), so the failure is injected at the module
 * boundary instead, matching how the pull-side guard is proven.
 *
 * @param message Error message the copy-back throws.
 * @param opts.partial When true, write a truncated destination before throwing,
 *   reproducing the mid-copy remnant the push mirror would otherwise publish.
 * @param opts.fatal When true, throw a `NomadFatal` (a deliberate failure that
 *   carries its own recovery instruction) instead of a raw `Error`.
 */
function mockCopyBackFailure(
  message: string,
  opts: { partial?: boolean; fatal?: boolean } = {},
): void {
  vi.doMock('./links.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof linksModule>();
    const { NomadFatal } = await import('./utils.ts');
    return {
      ...actual,
      copySharedLinkPull: (_src: string, dst: string): never => {
        if (opts.partial === true) {
          mkdirSync(dst, { recursive: true });
          writeFileSync(join(dst, 'partial.txt'), 'half a file\n');
        }
        throw opts.fatal === true ? new NomadFatal(message) : new Error(message);
      },
    };
  });
}

/**
 * Divert the CLEANUP removal of `linkPath` (the copy-back guard's
 * `clearPartialCopy`) while letting the move's own removal of the same path
 * through.
 *
 * Keyed on the path plus an explicit "already saw the move's removal" flag
 * rather than on a call ordinal: an ordinal silently shifts if any earlier step
 * (`backupBeforeWrite`, say) ever gains an `rmSync`, and the test would keep
 * passing while exercising a different call than the one it names.
 *
 * @param linkPath Host-side path whose second removal is diverted.
 * @param mode `'throw'` fails the cleanup; `'noop'` reports success while
 *   leaving the entry in place, the win32 delete-pending case.
 * @param message Error message for `'throw'`.
 */
function mockCleanupRemoval(linkPath: string, mode: 'throw' | 'noop', message = ''): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    let sawMoveRemoval = false;
    return {
      ...actual,
      rmSync: (...args: Parameters<typeof actual.rmSync>): void => {
        if (String(args[0]) !== linkPath) {
          actual.rmSync(...args);
          return;
        }
        if (!sawMoveRemoval) {
          sawMoveRemoval = true;
          actual.rmSync(...args);
          return;
        }
        if (mode === 'throw') throw new Error(message);
      },
    };
  });
}

describe('cmdAdopt win32 copy-back failure', () => {
  let env: Env;
  const realPlatform = process.platform;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.doUnmock('./links.ts');
    vi.doUnmock('./utils.ts');
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('node:fs');
    teardownAdoptEnv(env);
  });

  it('win32: reports one failure and exits 1 instead of reaching the crash report', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyBackFailure('EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');

    // No rethrow past cmdAdopt: a NomadFatal renders as one message, so the
    // top-level handler never writes a crash report for this.
    expect(() => cmdAdopt('my-tools')).not.toThrow();
    expect(process.exitCode).toBe(EXIT.GENERIC_FAILURE);

    const out = errOutput(env);
    expect(out).toContain(linkPath);
    expect(out).toContain('EBUSY: resource busy or locked');
    expect(out).toContain('nomad pull');
  });

  it('win32: stages shared/<name> anyway so one push still publishes the adopted content', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyBackFailure('EPERM: operation not permitted');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    // The move itself succeeded: content is in shared/ and it is staged.
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');
    expect(readFileSync(join(sharedTarget, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(diffCached(env)).toContain('shared/my-tools');

    // And the success line never printed, so nothing claims the adopt finished.
    expect(logOutput(env)).not.toContain('adopted my-tools;');
  });

  it('win32: names the backup dir when a snapshot was written', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyBackFailure('EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(errOutput(env)).toContain('under backup/');
  });

  it('win32: does not name a backup dir when the snapshot no-opped', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    // backupBeforeWrite no-ops (and reports it) when there is nothing to
    // snapshot; the message must not advertise a directory holding nothing.
    vi.doMock('./utils.fs.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof utilsFsModule>()),
      backupBeforeWrite: (): boolean => false,
    }));
    mockCopyBackFailure('EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('could not restore the local copy');
    expect(out).not.toContain('backup/');
  });

  it('win32: clears a partial copy so the next push cannot publish the remnant', async () => {
    // The win32 push mirror wipes shared/<name> and rebuilds it from the host
    // path, so a truncated remnant here would overwrite the fully adopted
    // content in the repo and propagate that loss to every other host. An
    // absent host entry is what makes the mirror skip the name.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(linkPath, 'other.sh'), '#!/bin/sh\necho there\n');

    mockCopyBackFailure('EBUSY: resource busy or locked', { partial: true });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(existsSync(linkPath)).toBe(false);
    // shared/<name> still holds everything the move copied in.
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');
    expect(existsSync(join(sharedTarget, 'tool.sh'))).toBe(true);
    expect(existsSync(join(sharedTarget, 'other.sh'))).toBe(true);
    // With the remnant gone, the message carries no do-not-push warning.
    expect(errOutput(env)).not.toContain('do NOT run');
  });

  it('win32: warns against pushing when the partial copy cannot be cleared', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    // Whatever blocks the copy usually blocks the cleanup too.
    mockCleanupRemoval(linkPath, 'throw', 'EBUSY: resource busy or locked');
    mockCopyBackFailure('EBUSY: resource busy or locked', { partial: true });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('do NOT run');
    expect(out).toContain('nomad push');
  });

  it('win32: re-running after the failure points at nomad pull, not "nothing to adopt"', async () => {
    // The failure path clears the partial local copy, so linkPath is gone while
    // shared/<name> is fully populated. Answering "nothing to adopt" there
    // would be a dead end: the content is in the repo and one pull brings it
    // back, which is what the already-adopted branch says.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyBackFailure('EBUSY: resource busy or locked', { partial: true });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');
    expect(existsSync(linkPath)).toBe(false);

    // Second run, same state the user is now in.
    env.logSpy.mockClear();
    process.exitCode = 0;
    cmdAdopt('my-tools');

    const out = logOutput(env);
    expect(out).toContain('already adopted');
    expect(out).toContain('nomad pull');
    expect(out).not.toContain('nothing to adopt');
    expect(process.exitCode).toBe(0);
  });

  it('win32: reports a removal only when the path is actually gone afterwards', async () => {
    // A win32 delete can be accepted and still leave the entry until the last
    // handle closes, which is exactly the state this runs in. Reporting a
    // removal that did not happen is what would let the next push mirror
    // publish the remnant, so the result is a re-probe, not the absence of a
    // throw. rmSync is stubbed to no-op on the cleanup call only.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCleanupRemoval(linkPath, 'noop');
    mockCopyBackFailure('EBUSY: resource busy or locked', { partial: true });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(existsSync(linkPath)).toBe(true);
    expect(errOutput(env)).toContain('do NOT run');
  });

  it('win32: re-throws a deliberate failure untouched rather than wrapping it', async () => {
    // A NomadFatal from the copy carries its own message and exit code, and
    // names the one command that clears it. Wrapping it would append a second,
    // contradictory instruction.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyBackFailure('cannot overlay a file onto a directory; run `nomad pull --force-remote`', {
      fatal: true,
    });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('nomad pull --force-remote');
    expect(out).not.toContain('could not restore the local copy');
    // Still staged, so the repo half of the move is not left half-done.
    expect(diffCached(env)).toContain('shared/my-tools');
  });

  it('win32: a staging failure on the re-thrown arm is reported, not swallowed', async () => {
    // The deliberate failure is re-thrown untouched, so a staging failure
    // cannot ride along inside its message. It gets its own line instead of
    // disappearing, which would leave the docs claiming it was staged.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: (): never => {
          throw new actual.NomadFatal('git add shared/my-tools failed');
        },
      };
    });
    mockCopyBackFailure('cannot overlay a file onto a directory', { fatal: true });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('cannot overlay a file onto a directory');
    expect(out).toContain('not staged');
  });

  it('win32: a staging failure is reported alongside the copy-back failure, not instead of it', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: (): never => {
          throw new actual.NomadFatal('git add shared/my-tools failed');
        },
      };
    });
    mockCopyBackFailure('EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    // Both facts survive: the user learns the local copy is gone AND that the
    // repo content is not staged.
    expect(out).toContain('could not restore the local copy');
    expect(out).toContain('not staged');
  });

  it.skipIf(isWin)(
    'posix: an unexpected error still reaches the crash-report path (copy-back)',
    async () => {
      // Not a NomadFatal, so cmdAdopt must rethrow rather than swallow it: the
      // top-level handler is what turns an unexpected fault into a report.
      addSharedDir(env, 'my-tools');
      const linkPath = join(env.claudeHome, 'my-tools');
      mkdirSync(linkPath, { recursive: true });
      writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

      vi.doMock('./utils.fs.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof utilsFsModule>()),
        ensureSymlink: (): never => {
          throw new Error('ENOSPC: no space left on device');
        },
      }));
      const { cmdAdopt } = await import('./commands.adopt.ts');

      expect(() => cmdAdopt('my-tools')).toThrow('ENOSPC: no space left on device');
    },
  );
});

// ---------------------------------------------------------------------------
// The two filesystem calls ahead of the copy-back: the copy into shared/<name>
// and the removal of the source
// ---------------------------------------------------------------------------

/**
 * Fail the move's copy INTO the repo, leaving the host untouched.
 *
 * Keyed on the destination rather than on a call count, because
 * `backupBeforeWrite` copies first and would otherwise absorb the failure.
 *
 * @param sharedTarget Destination whose copy should throw.
 * @param message Error message the copy throws.
 * @param opts.partial When true, write a truncated destination before throwing,
 *   reproducing the remnant that would otherwise block every retry.
 * @param opts.unclearable When true, also fail the cleanup removal of that
 *   destination, the state where the message has to name the path instead.
 */
function mockCopyIntoSharedFailure(
  sharedTarget: string,
  message: string,
  opts: { partial?: boolean; unclearable?: boolean } = {},
): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    return {
      ...actual,
      cpSync: (...args: Parameters<typeof actual.cpSync>): void => {
        if (String(args[1]) !== sharedTarget) {
          actual.cpSync(...args);
          return;
        }
        if (opts.partial === true) {
          actual.mkdirSync(sharedTarget, { recursive: true });
          actual.writeFileSync(join(sharedTarget, 'partial.txt'), 'half a file\n');
        }
        throw new Error(message);
      },
      rmSync: (...args: Parameters<typeof actual.rmSync>): void => {
        if (opts.unclearable === true && String(args[0]) === sharedTarget) {
          throw new Error(message);
        }
        actual.rmSync(...args);
      },
    };
  });
}

/**
 * Fail the move's removal of the source directory, the call whose meaning
 * differs by platform. Keyed on the exact path so the copy-back's own
 * housekeeping removals still run.
 *
 * @param linkPath Host-side path whose removal should fail.
 * @param message Error message the removal throws.
 * @param opts.onlyFirst When true, divert only the move's own removal and let
 *   any later removal of the same path through, so a test can prove what does
 *   NOT get deleted afterwards rather than relying on a second failure to
 *   protect it.
 * @param opts.accepted When true, report success without removing anything,
 *   the win32 delete-pending case the re-probe exists to catch.
 * @param opts.thrown Throw this value verbatim instead of an `Error`, for the
 *   non-`Error` throw the message formatting has to survive.
 */
function mockSourceRemovalFailure(
  linkPath: string,
  message: string,
  opts: { onlyFirst?: boolean; accepted?: boolean; thrown?: unknown } = {},
): void {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fsModule>();
    let diverted = false;
    return {
      ...actual,
      rmSync: (...args: Parameters<typeof actual.rmSync>): void => {
        if (String(args[0]) !== linkPath || (opts.onlyFirst === true && diverted)) {
          actual.rmSync(...args);
          return;
        }
        diverted = true;
        if (opts.accepted === true) return;
        // Throwing a non-Error is the point when opts.thrown is set: the
        // message formatting has to survive a value with no `.message`.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw opts.thrown ?? new Error(message);
      },
    };
  });
}

describe('cmdAdopt copy-into-shared failure', () => {
  let env: Env;
  const realPlatform = process.platform;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.doUnmock('node:fs');
    teardownAdoptEnv(env);
  });

  it('reports the failure and leaves the host untouched', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockCopyIntoSharedFailure(
      join(env.repoHome, 'shared', 'my-tools'),
      'EACCES: permission denied',
    );
    const { cmdAdopt } = await import('./commands.adopt.ts');

    // A NomadFatal, so it renders as one message instead of a crash report.
    expect(() => cmdAdopt('my-tools')).not.toThrow();
    expect(process.exitCode).toBe(EXIT.GENERIC_FAILURE);

    const out = errOutput(env);
    expect(out).toContain('EACCES: permission denied');
    expect(out).toContain('nomad adopt my-tools');
    // Nothing was removed: the source is exactly as it was.
    expect(readFileSync(join(linkPath, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(diffCached(env)).toBe('');
  });

  it('clears the partial copy so the retry it recommends is not refused', async () => {
    // adoptStopsEarly refuses any run whose shared/<name> already exists, so a
    // remnant left here would turn `re-run adopt` into a manual rm first.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');

    mockCopyIntoSharedFailure(sharedTarget, 'EACCES: permission denied', { partial: true });
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(existsSync(sharedTarget)).toBe(false);
    expect(errOutput(env)).not.toContain('may still be in the repo');

    // Second run, the one the message told the user to make: it reaches the
    // copy again rather than being turned away by the clobber refusal.
    env.errorSpy.mockClear();
    process.exitCode = 0;
    cmdAdopt('my-tools');
    expect(errOutput(env)).not.toContain('would clobber');
    expect(errOutput(env)).toContain('EACCES: permission denied');
  });

  it('posix: names the partial copy when it cannot be cleared', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');

    mockCopyIntoSharedFailure(sharedTarget, 'EACCES: permission denied', {
      partial: true,
      unclearable: true,
    });
    stubPlatform('linux');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(existsSync(sharedTarget)).toBe(true);
    const out = errOutput(env);
    expect(out).toContain('A partial shared/my-tools may still be in the repo');
    expect(out).toContain('adopt refuses to run while it is there');
  });

  it('win32: says a re-run would call the fragment adopted, not refuse it', async () => {
    // adoptStopsEarly asks reportWin32AlreadyAdopted BEFORE the would-clobber
    // refusal, and that helper fires on the mere existence of shared/<name>. So
    // on win32 the next run reports success over a mid-copy fragment, and the
    // `nomad pull` it suggests would copy that fragment over a host directory
    // this failure left whole. Promising a refusal there is the one wording
    // that could cost content.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');

    mockCopyIntoSharedFailure(sharedTarget, 'EACCES: permission denied', {
      partial: true,
      unclearable: true,
    });
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('already exists as adopted');
    expect(out).toContain(linkPath);
    expect(out).not.toContain('adopt refuses to run while it is there');
  });
});

describe('cmdAdopt source-removal failure', () => {
  let env: Env;
  const realPlatform = process.platform;

  beforeEach(() => {
    env = makeAdoptEnv();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.doUnmock('node:fs');
    vi.doUnmock('./links.ts');
    vi.doUnmock('./utils.ts');
    teardownAdoptEnv(env);
  });

  it('win32: warns and finishes, because both copies IS the adopted state there', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, 'EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    // Exit 0 and the success line, because the host really is adopted: a real
    // local copy beside a populated shared/<name> is what win32 adopt produces.
    expect(process.exitCode).toBe(0);
    expect(logOutput(env)).toContain('adopted my-tools;');
    const sharedTarget = join(env.repoHome, 'shared', 'my-tools');
    expect(readFileSync(join(sharedTarget, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(readFileSync(join(linkPath, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(diffCached(env)).toContain('shared/my-tools');

    // The warning still names the path and quotes the errno, so the user can
    // tell this run apart from an ordinary one.
    const out = errOutput(env);
    expect(out).toContain(linkPath);
    expect(out).toContain('EBUSY: resource busy or locked');
  });

  it('win32: falls through to the copy-back guard when the lock blocks that too', async () => {
    // The usual case: whatever held the directory open against the delete holds
    // it against the rewrite as well, so the warn arm self-limits.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, 'EBUSY: resource busy or locked');
    mockCopyBackFailure('EBUSY: resource busy or locked');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(process.exitCode).toBe(EXIT.GENERIC_FAILURE);
    const out = errOutput(env);
    expect(out).toContain('could not restore the local copy');
    expect(out).toContain('nomad pull');
    expect(logOutput(env)).not.toContain('adopted my-tools;');
  });

  it('win32: leaves the intact original alone when the copy-back fails too', async () => {
    // The regression this guards: the copy-back's cleanup exists to clear a
    // TRUNCATED remnant, and on this arm the path holds the complete original
    // instead. Running it here would recursively delete a healthy directory,
    // and this arm is reached precisely when another process holds that
    // directory open and may have written to it since the copy into the repo,
    // which is content that is in neither shared/<name> nor the backup. The
    // mock lets a later removal of the same path through, so the assertion
    // fails if the cleanup is ever restored to this path.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, 'EBUSY: resource busy or locked', { onlyFirst: true });
    mockCopyBackFailure('EPERM: operation not permitted');
    stubPlatform('win32');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(readFileSync(join(linkPath, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    const out = errOutput(env);
    expect(out).toContain('The original is still at');
    // No do-not-push warning: publishing that original is the right outcome.
    expect(out).not.toContain('do NOT run');
  });

  it('posix: treats an accepted but pending delete as a failure, not a removal', async () => {
    // The move's own rmSync gets the same re-probe discipline as the cleanup:
    // on win32 a delete can be accepted and leave the entry until the last
    // handle closes, and trusting the missing throw would carry on to
    // ensureSymlink against a live path for a vaguer error.
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, '', { accepted: true });
    stubPlatform('linux');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(process.exitCode).toBe(EXIT.GENERIC_FAILURE);
    expect(errOutput(env)).toContain('the delete was accepted but the entry is still there');
  });

  it('posix: quotes a non-Error throw instead of reporting undefined', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, '', { thrown: 'EPERM: operation not permitted' });
    stubPlatform('linux');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    expect(out).toContain('EPERM: operation not permitted');
    expect(out).not.toContain('undefined');
  });

  it('posix: fails, because a real directory is where the symlink belongs', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    mockSourceRemovalFailure(linkPath, 'EACCES: permission denied');
    stubPlatform('linux');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    expect(process.exitCode).toBe(EXIT.GENERIC_FAILURE);
    const out = errOutput(env);
    expect(out).toContain(linkPath);
    expect(out).toContain('EACCES: permission denied');
    expect(out).toContain('nomad pull');
    expect(out).toContain('and staged.');

    // Staged, so one push still publishes the adopted content; and the source
    // is still a real directory, never replaced by a half-made symlink.
    expect(diffCached(env)).toContain('shared/my-tools');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(logOutput(env)).not.toContain('adopted my-tools;');
  });

  it('posix: a staging failure is reported alongside the removal failure', async () => {
    addSharedDir(env, 'my-tools');
    const linkPath = join(env.claudeHome, 'my-tools');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'tool.sh'), '#!/bin/sh\necho hi\n');

    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitOrFatal: (): never => {
          throw new actual.NomadFatal('git add shared/my-tools failed');
        },
      };
    });
    mockSourceRemovalFailure(linkPath, 'EACCES: permission denied');
    stubPlatform('linux');
    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('my-tools');

    const out = errOutput(env);
    // Both facts survive: the original is still there AND it is not staged.
    expect(out).toContain('could not remove the original');
    expect(out).toContain('not staged');
  });
});
