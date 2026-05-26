import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, type MockInstance } from 'vitest';

// Shared fixtures for the cmdDropSession integration suites. Each test sets up
// a real `git init`'d temp REPO_HOME (`<testHome>/claude-nomad/`) plus a temp
// `<testHome>/.claude/` host root and exercises the command end-to-end against
// synthetic `shared/projects/*/<sid>.jsonl` fixtures. The same harness backs
// the validation/idempotency suite and the match-collection/unstage suite.

/** `vi.spyOn(process, 'exit')` return type, reused so tests skip the long generic. */
export type ExitSpy = MockInstance<(code?: string | number | null) => never>;
/** `vi.spyOn(console, 'error'|'log')` return type, reused across the spies. */
export type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** Sandbox state returned by `makeDropSessionEnv` for each cmdDropSession test. */
export type Env = {
  originalHome: string | undefined;
  originalNomadHost: string | undefined;
  testHome: string;
  repoUnderHome: string;
  sharedProjects: string;
  claudeProjects: string;
  lockPath: string;
  exitSpy: ExitSpy;
  errorSpy: LogSpy;
  logSpy: LogSpy;
};

/**
 * Initialize a real git repo at `repoUnderHome` so the unstage primitives
 * (`git restore --staged`, `git rm --cached`, `git ls-files --error-unmatch`)
 * have an index to mutate.
 *
 * @param repoUnderHome Absolute path to the temp `claude-nomad/` repo root.
 */
export function initRepo(repoUnderHome: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoUnderHome });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: repoUnderHome,
  });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoUnderHome });
}

/**
 * Create an isolated HOME sandbox for `cmdDropSession` tests: a temp HOME with
 * a `git init`'d `claude-nomad/` repo, a `shared/projects/` tree, a `.claude/`
 * host root, and spies on `process.exit`, `console.error`, `console.log`, and
 * `process.stderr.write`. Resets the module cache so each test loads fresh.
 *
 * @returns An `Env` capturing the sandbox paths and the installed spies.
 */
export function makeDropSessionEnv(): Env {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-dropsession-test-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  const repoUnderHome = join(testHome, 'claude-nomad');
  const sharedProjects = join(repoUnderHome, 'shared', 'projects');
  const claudeProjects = join(testHome, '.claude', 'projects');
  const lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
  mkdirSync(sharedProjects, { recursive: true });
  mkdirSync(claudeProjects, { recursive: true });
  initRepo(repoUnderHome);
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
  // Suppress `process.stderr.write` output during the test (warn/fail glyph
  // output goes through console.error and is captured by errorSpy).
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    originalHome,
    originalNomadHost,
    testHome,
    repoUnderHome,
    sharedProjects,
    claudeProjects,
    lockPath,
    exitSpy,
    errorSpy,
    logSpy,
  };
}

/**
 * Tear down a sandbox created by `makeDropSessionEnv`: restore all mocks, the
 * SUT module mock, `process.exitCode`, and the saved env vars, then remove the
 * temp HOME tree.
 *
 * @param env The sandbox to tear down.
 */
export function teardownDropSessionEnv(env: Env): void {
  vi.restoreAllMocks();
  vi.doUnmock('./commands.drop-session.ts');
  process.exitCode = 0;
  if (env.originalHome !== undefined) process.env.HOME = env.originalHome;
  else delete process.env.HOME;
  if (env.originalNomadHost !== undefined) process.env.NOMAD_HOST = env.originalNomadHost;
  else delete process.env.NOMAD_HOST;
  rmSync(env.testHome, { recursive: true, force: true });
}

/**
 * Stage `shared/projects/<logical>/<sid>.jsonl` (creating dirs as needed) with
 * the given content. Returns the absolute path of the staged file.
 *
 * @param env The sandbox returned by `makeDropSessionEnv`.
 * @param logical The logical project name (a `shared/projects/` child dir).
 * @param sid The session id (filename minus `.jsonl`).
 * @param content The file body to write before staging.
 * @returns The absolute path of the staged file.
 */
export function stageSession(env: Env, logical: string, sid: string, content: string): string {
  const dir = join(env.sharedProjects, logical);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, content);
  const rel = `shared/projects/${logical}/${sid}.jsonl`;
  execFileSync('git', ['add', rel], { cwd: env.repoUnderHome });
  return path;
}

/**
 * Stage one nested entry under the sibling subagent directory
 * `shared/projects/<logical>/<sid>/<relName>` (creating parent dirs as needed)
 * with the given content. Mirrors `stageSession` but targets the `<sid>/`
 * directory tree (keyed by the same session id) rather than the flat
 * `<sid>.jsonl`. Returns the absolute path of the staged file.
 *
 * @param env The sandbox returned by `makeDropSessionEnv`.
 * @param logical The logical project name (a `shared/projects/` child dir).
 * @param sid The session id whose `<sid>/` subagent tree is targeted.
 * @param relName The path of the nested entry relative to `<sid>/`.
 * @param content The file body to write before staging.
 * @returns The absolute path of the staged file.
 */
export function stageSessionDir(
  env: Env,
  logical: string,
  sid: string,
  relName: string,
  content: string,
): string {
  const path = join(env.sharedProjects, logical, sid, relName);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  const rel = `shared/projects/${logical}/${sid}/${relName}`;
  execFileSync('git', ['add', rel], { cwd: env.repoUnderHome });
  return path;
}

/**
 * Read `git diff --cached --name-only` from the temp repo as a single trimmed
 * string. Useful to assert that a file is or is not in the staged tree without
 * depending on `git ls-files` quoting.
 *
 * @param env The sandbox returned by `makeDropSessionEnv`.
 * @returns The trimmed `git diff --cached --name-only` output.
 */
export function diffCached(env: Env): string {
  return execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: env.repoUnderHome,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/**
 * Stitch every recorded `console.error` call into a single newline-joined
 * string so substring assertions can match across multiple emits.
 *
 * @param env The sandbox returned by `makeDropSessionEnv`.
 * @returns The recorded `console.error` calls joined by newlines.
 */
export function errOutput(env: Env): string {
  return env.errorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}
