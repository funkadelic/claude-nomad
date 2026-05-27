import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, type MockInstance } from 'vitest';

// Shared harness for the cmdPush pipeline suites (boundary gates, summary
// terminators, lock-contention skip, extras integration). Each test loads
// cmdPush dynamically AFTER vi.resetModules() + per-test vi.doMock of the
// pipeline dependencies (./push-checks.ts, ./push-gitleaks.ts, ./remap.ts,
// ./extras-sync.ts, ./utils.ts, node:child_process) so the NomadFatal class
// thrown from a mock factory shares identity with the copy cmdPush catches.
// The sandbox is a temp HOME with a `claude-nomad/` repo dir, a `shared/`
// subtree, a `.claude/` host root, and a default `path-map.json`.

/** `vi.spyOn(console, 'error'|'log')` return type, reused across the spies. */
export type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** Sandbox state returned by `makePushEnv` for each cmdPush pipeline test. */
export type PushEnv = {
  originalHome: string | undefined;
  originalNomadHost: string | undefined;
  originalExitCode: typeof process.exitCode;
  testHome: string;
  repoUnderHome: string;
  lockPath: string;
  errSpy: LogSpy;
  logSpy: LogSpy;
};

/**
 * Create an isolated HOME sandbox for cmdPush pipeline tests: a temp HOME with
 * a `claude-nomad/` repo dir (NOT a real git repo; tests that need git mock
 * node:child_process), a `shared/` subtree, a `.claude/` host root, a default
 * `path-map.json` (`{ projects: {} }`), and spies on `console.error`,
 * `console.log`, and `process.stderr.write`. Resets the module cache so each
 * test loads a fresh cmdPush.
 *
 * @returns A `PushEnv` capturing the sandbox paths and the installed spies.
 */
export function makePushEnv(): PushEnv {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const originalExitCode = process.exitCode;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-push-test-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  const repoUnderHome = join(testHome, 'claude-nomad');
  const lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
  // The gitlink walk needs shared/ to exist (findGitlinks is tolerant of a
  // missing dir but the explicit dir keeps the integration realistic).
  mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
  mkdirSync(join(testHome, '.claude'), { recursive: true });
  // path-map.json must be present so cmdPush's existsSync(mapPath) check passes
  // when the flow reaches the allow-list step.
  writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
  vi.resetModules();
  const errSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    originalHome,
    originalNomadHost,
    originalExitCode,
    testHome,
    repoUnderHome,
    lockPath,
    errSpy,
    logSpy,
  };
}

/**
 * Tear down a sandbox created by `makePushEnv`: restore all mocks, unmock every
 * pipeline dependency a test may have mocked (idempotent for unmocked
 * modules), restore the saved `process.exitCode` and env vars, and remove the
 * temp HOME tree.
 *
 * @param env The sandbox to tear down.
 */
export function teardownPushEnv(env: PushEnv): void {
  vi.restoreAllMocks();
  vi.doUnmock('./push-checks.ts');
  vi.doUnmock('./push-gitleaks.ts');
  vi.doUnmock('./remap.ts');
  vi.doUnmock('./extras-sync.ts');
  vi.doUnmock('./utils.ts');
  vi.doUnmock('./utils.lockfile.ts');
  vi.doUnmock('node:child_process');
  process.exitCode = env.originalExitCode;
  if (env.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.originalHome;
  if (env.originalNomadHost === undefined) delete process.env.NOMAD_HOST;
  else process.env.NOMAD_HOST = env.originalNomadHost;
  rmSync(env.testHome, { recursive: true, force: true });
}

/**
 * Stitch every recorded `console.error` call into a single newline-joined
 * string so a regex or substring assertion can survey the whole output.
 *
 * @param env The sandbox returned by `makePushEnv`.
 * @returns The recorded `console.error` calls joined by newlines.
 */
export function errOutput(env: PushEnv): string {
  return env.errSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/**
 * Stitch every recorded `console.log` call into a single newline-joined string
 * so a regex or substring assertion can survey the whole output.
 *
 * @param env The sandbox returned by `makePushEnv`.
 * @returns The recorded `console.log` calls joined by newlines.
 */
export function logOutput(env: PushEnv): string {
  return env.logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}
