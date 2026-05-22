import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, type MockInstance } from 'vitest';

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

/**
 * Produce git `remote -v` formatted output from a map of remote names to URLs.
 *
 * Each entry produces two lines: one with `(fetch)` and one with `(push)`.
 * `parseRemotes` only consumes `(fetch)`, but emitting production-shaped
 * output keeps the test honest against the real git CLI format.
 *
 * @param remotes - Mapping of remote name to its URL
 * @returns A `git remote -v`-style string where each remote has `(fetch)` and `(push)` lines; includes a trailing newline when there is at least one line
 */
export function formatRemoteV(remotes: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, url] of Object.entries(remotes)) {
    lines.push(`${name}\t${url} (fetch)`, `${name}\t${url} (push)`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** Shape passed to `mockGit` so each test declares only the bits it cares
 * about; defaults cover the "vanilla healthy" path. */
export type GitBehavior = {
  remotes?: Record<string, string>;
  branch?: string;
  status?: string;
  diffNames?: string;
  pullThrows?: Error;
  fetchThrows?: Error;
  mergeThrows?: Error;
  /** When set, `git rev-parse --abbrev-ref HEAD` throws this error. Used to
   * exercise `currentBranch`'s NomadFatal-wrapping catch arm. */
  branchThrows?: Error;
  /** When set, `git rev-parse HEAD` throws this error. Used to exercise
   * `headSha`'s NomadFatal-wrapping catch arm. */
  headShaThrows?: Error;
  /** When set, `git remote -v` throws this error. Used to exercise
   * `loadTopology`'s NomadFatal-wrapping catch arm. */
  remoteThrows?: Error;
  /** Output for `git diff --name-only --diff-filter=U`: newline-separated
   * unmerged paths after a failed merge. Empty/unset = no unmerged paths. */
  unmergedPaths?: string;
};

/** Single recorded execFileSync invocation; used by tests to assert on the
 * exact argv shape and ordering of git/npm calls. */
export type RecordedCall = { bin: string; args: readonly string[] };

/** Per-command handler: returns the canned output (or throws the configured
 * error). Each handler is keyed by `git ${args[0]}` or `npm ${args[0]}` for
 * dispatch via a table, which keeps `mockGit`'s `execFileSync` body flat. */
type Handler = (behavior: GitBehavior, args: readonly string[]) => Buffer;

const HANDLERS: Record<string, Handler> = {
  'git remote': (b, args) => {
    if (args[1] !== '-v') throw new Error(`unhandled: git remote ${args.join(' ')}`);
    if (b.remoteThrows !== undefined) throw b.remoteThrows;
    return Buffer.from(formatRemoteV(b.remotes ?? {}));
  },
  'git rev-parse': (b, args) => {
    if (args[1] === '--abbrev-ref') {
      if (b.branchThrows !== undefined) throw b.branchThrows;
      return Buffer.from((b.branch ?? 'main') + '\n');
    }
    if (args[1] === 'HEAD') {
      if (b.headShaThrows !== undefined) throw b.headShaThrows;
      return Buffer.from('0123456789abcdef0123456789abcdef01234567\n');
    }
    throw new Error(`unhandled: git rev-parse ${args.join(' ')}`);
  },
  'git status': (b) => Buffer.from(b.status ?? ''),
  'git pull': (b) => {
    if (b.pullThrows !== undefined) throw b.pullThrows;
    return Buffer.from('');
  },
  'git fetch': (b) => {
    if (b.fetchThrows !== undefined) throw b.fetchThrows;
    return Buffer.from('');
  },
  'git merge': (b) => {
    if (b.mergeThrows !== undefined) throw b.mergeThrows;
    return Buffer.from('');
  },
  'git push': () => Buffer.from(''),
  'git diff': (b, args) => {
    if (args.includes('--diff-filter=U')) return Buffer.from(b.unmergedPaths ?? '');
    return Buffer.from(b.diffNames ?? '');
  },
  'git checkout': () => Buffer.from(''),
  'git add': () => Buffer.from(''),
  'git commit': () => Buffer.from(''),
  'npm install': () => Buffer.from(''),
};

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
