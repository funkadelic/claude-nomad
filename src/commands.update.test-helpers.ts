import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, type MockInstance } from 'vitest';

import { type GitBehavior, HANDLERS } from './commands.update.test-helpers.git.ts';

/** Type alias matching the `vi.spyOn(console, 'log'|'error')` return so tests
 * can pass the spy around without re-typing the long generic signature. */
export type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** Sandbox environment returned by `makeUpdateEnv` for each cmdUpdate test. */
export type Env = { testHome: string; logSpy: LogSpy; errSpy: LogSpy };

/**
 * Create an isolated HOME sandbox for `cmdUpdate` tests.
 *
 * Sets `process.env.HOME` to the created directory and pre-creates a
 * `claude-nomad/` subdirectory so `existsSync(REPO_HOME)` is true during the
 * test (tests that want to exercise the missing-repo path remove it
 * explicitly). Resets the module cache so tests load fresh modules.
 *
 * @returns An `Env` containing `testHome` (the sandbox HOME path) and spies for `console.log` and `console.error`.
 */
export function makeUpdateEnv(): Env {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-update-test-'));
  process.env.HOME = testHome;
  mkdirSync(join(testHome, 'claude-nomad'), { recursive: true });
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    // Capture only; assertions inspect call list.
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
    // Capture only.
  });
  return { testHome, logSpy, errSpy };
}

/**
 * Concatenates captured console calls into a single newline-separated string.
 *
 * Each recorded call's arguments are joined with a space, and calls are
 * joined with `\n`. Lets tests assert on substrings without iterating
 * `spy.mock.calls` directly.
 *
 * @param spy - The log spy produced by spying on `console.log` or `console.error`
 * @returns A string where each captured call's arguments are joined by a space and calls are separated by `\n`
 */
export function joinedLog(spy: LogSpy): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/**
 * Restore an environment variable to a previously captured original value.
 *
 * @param name - The environment variable name to restore
 * @param original - The original value to restore; if `undefined`, the variable will be removed
 */
export function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/** Single recorded execFileSync invocation; used by tests to assert on the
 * exact argv shape and ordering of git/npm calls. */
export type RecordedCall = { bin: string; args: readonly string[] };

/**
 * Provide a mocked child_process that yields deterministic git/npm outputs and records every invocation for test assertions.
 *
 * Routes by `bin` + `args[0]` through the `HANDLERS` dispatch table. Tracks
 * every call on the returned `calls` array so tests can assert on argv shape
 * and order. `cmdDoctor` is mocked separately (see `mockDoctor`) so this
 * mock only needs to cover the direct git/npm shell-outs.
 *
 * @param behavior - Configuration controlling returned output and thrown errors for specific git/npm invocations
 * @returns An object with `calls`, an array of recorded `{ bin, args }` invocations in the order they occurred
 */
export function mockGit(behavior: GitBehavior): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (
          bin: string,
          args: readonly string[],
          opts?: Parameters<typeof cpModule.execFileSync>[2],
        ) => {
          calls.push({ bin, args });
          const handler = HANDLERS[`${bin} ${args[0]}`];
          if (handler !== undefined) return handler(behavior, args);
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
  return { calls };
}

/**
 * Replace the doctor command with a spy so the real diagnostic does not run during tests.
 *
 * `cmdDoctor` would otherwise touch `~/.claude/`, gitleaks, the version-check
 * cache, etc., which the unit tests for `cmdUpdate` have no business
 * exercising. Installs a mock for `./commands.doctor.ts` that exposes
 * `cmdDoctor` as a Vitest spy callers can assert on.
 *
 * @returns An object containing `spy`, the Vitest spy function that replaced `cmdDoctor`
 */
export function mockDoctor(): { spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn();
  vi.doMock('./commands.doctor.ts', () => ({
    cmdDoctor: spy,
  }));
  return { spy };
}

export const PUBLIC_SSH = 'git@github.com:funkadelic/claude-nomad.git';
export const PUBLIC_HTTPS = 'https://github.com/funkadelic/claude-nomad';
export const PRIVATE_SSH = 'git@github.com:norman/private-config.git';
