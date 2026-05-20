import type { execFileSync } from 'node:child_process';
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
 * Build a sandbox env for `cmdUpdate` tests: creates a temp `HOME` with an
 * empty `claude-nomad/` directory so `existsSync(REPO_HOME)` is true. Returns
 * the temp dir plus `console.log`/`console.error` spies so callers can assert
 * on output without iterating `mock.calls` directly.
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

/** Concatenate every captured `console.log`/`error` call into a single
 * newline-joined string, so tests can assert on substrings without iterating
 * `mock.calls`. */
export function joinedLog(spy: LogSpy): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/** Restore each env var to its captured original (or delete when unset). */
export function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/**
 * Format a `git remote -v` payload from a `{ name: url }` map. Each remote
 * gets both a `(fetch)` and a `(push)` line; only `(fetch)` is parsed but
 * production-shaped output keeps the test honest.
 */
export function formatRemoteV(remotes: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, url] of Object.entries(remotes)) {
    lines.push(`${name}\t${url} (fetch)`);
    lines.push(`${name}\t${url} (push)`);
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
};

/** Single recorded execFileSync invocation; used by tests to assert on the
 * exact argv shape and ordering of git/npm calls. */
export type RecordedCall = { bin: string; args: readonly string[] };

/**
 * Mock `node:child_process` so the `git`/`npm` invocations cmdUpdate makes
 * become deterministic. Routes by `bin` + `args[0]`. Tracks every call on
 * the returned `calls` array so tests can assert on argv shape and order.
 * `cmdDoctor` is mocked separately (see `mockDoctor`) so this mock only
 * needs to cover the direct git/npm shell-outs.
 */
export function mockGit(behavior: GitBehavior): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
          calls.push({ bin, args });
          if (bin === 'git' && args[0] === 'remote' && args[1] === '-v') {
            return Buffer.from(formatRemoteV(behavior.remotes ?? {}));
          }
          if (bin === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
            return Buffer.from((behavior.branch ?? 'main') + '\n');
          }
          if (bin === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return Buffer.from('0123456789abcdef0123456789abcdef01234567\n');
          }
          if (bin === 'git' && args[0] === 'status') {
            return Buffer.from(behavior.status ?? '');
          }
          if (bin === 'git' && args[0] === 'pull') {
            if (behavior.pullThrows !== undefined) throw behavior.pullThrows;
            return Buffer.from('');
          }
          if (bin === 'git' && args[0] === 'fetch') {
            if (behavior.fetchThrows !== undefined) throw behavior.fetchThrows;
            return Buffer.from('');
          }
          if (bin === 'git' && args[0] === 'merge') {
            if (behavior.mergeThrows !== undefined) throw behavior.mergeThrows;
            return Buffer.from('');
          }
          if (bin === 'git' && args[0] === 'push') {
            return Buffer.from('');
          }
          if (bin === 'git' && args[0] === 'diff') {
            return Buffer.from(behavior.diffNames ?? '');
          }
          if (bin === 'npm' && args[0] === 'install') {
            return Buffer.from('');
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
  return { calls };
}

/**
 * Mock the doctor module so cmdUpdate's trailing invocation does not run
 * the full diagnostic (which would touch ~/.claude/, gitleaks, version
 * cache, etc.). Returns a spy on the mocked `cmdDoctor` for assertion.
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
