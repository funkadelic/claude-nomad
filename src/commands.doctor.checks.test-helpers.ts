import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, vi, type MockInstance } from 'vitest';

// home() prefers USERPROFILE over HOME on win32 (see config.ts). The shared
// vitest.setup.ts deletes USERPROFILE process-wide on win32, so a sandbox
// that stamps only HOME already isolates correctly. makeDoctorEnv used to
// ALSO set USERPROFILE to its own testHome, but that value outlived the
// per-test rmSync teardown (only a file-level afterAll restored it), so any
// later describe in the same file that stamped only HOME resolved home()
// through the stale, already-deleted sandbox on win32. It now deletes
// USERPROFILE instead, matching the setup-file convention; this afterAll
// restores the import-time value for cross-file hygiene in a shared worker.
const capturedUserProfile = process.env.USERPROFILE;
afterAll(() => {
  if (capturedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = capturedUserProfile;
});

/** Spy handle over `console.log`, captured by `makeDoctorEnv`. */
export type LogSpy = MockInstance<(...args: unknown[]) => void>;

/** A sandbox `cmdDoctor` environment: the temp `HOME` plus a console.log spy. */
export type Env = { testHome: string; logSpy: LogSpy };

/**
 * Build a sandbox env for `cmdDoctor` tests: creates a temp `HOME` with the
 * expected `claude-nomad/{shared,hosts}` and `.claude/` skeletons, optionally
 * writes `settings.base.json` (default on), optionally writes a
 * `.claude/settings.json` (default off), and optionally initializes a git
 * repo at `REPO_HOME` (default off; needed for the remote-URL and
 * rebase-clean-tree diagnostics). Returns the temp dir plus a `console.log`
 * spy so callers can assert on doctor's output.
 *
 * @param opts Sandbox knobs (host name, whether to write base/settings, git init).
 * @returns The sandbox `testHome` and a `console.log` spy.
 */
export function makeDoctorEnv(opts: {
  host?: string;
  writeBase?: boolean;
  writeSettings?: boolean;
  setupGitRepo?: boolean;
}): Env {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-test-home-'));
  process.env.HOME = testHome;
  // Delete (not set) USERPROFILE so home()'s win32 branch falls through to
  // the sandbox HOME, and no stale sandbox path can leak into later
  // describes in the same file (see the module-level comment above).
  delete process.env.USERPROFILE;
  if (opts.host !== undefined) process.env.NOMAD_HOST = opts.host;
  mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
  mkdirSync(join(testHome, 'claude-nomad', 'hosts'), { recursive: true });
  mkdirSync(join(testHome, '.claude'), { recursive: true });
  if (opts.writeBase !== false) {
    writeFileSync(
      join(testHome, 'claude-nomad', 'shared', 'settings.base.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
  }
  if (opts.writeSettings) {
    writeFileSync(
      join(testHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet' }) + '\n',
    );
  }
  if (opts.setupGitRepo) {
    // Initialize a real git repo at REPO_HOME so cmdDoctor's remote-URL and
    // rebase-clean-tree-WARN git invocations can run against it.
    // --quiet suppresses git's "hint: Using 'master' as the name..." stderr;
    // -b main pins the initial branch to avoid host-specific defaults.
    execFileSync('git', ['init', '--quiet', '-b', 'main'], {
      cwd: join(testHome, 'claude-nomad'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  vi.resetModules();
  const logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    // Capture only; assertions inspect call list.
  });
  return { testHome, logSpy };
}

/**
 * Concatenate every captured `console.log` call into a single newline-joined
 * string, so tests can assert on substrings without iterating `mock.calls`.
 *
 * @param logSpy The spy returned by `makeDoctorEnv`.
 * @returns The joined log output.
 */
export function joinedLog(logSpy: LogSpy): string {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

/**
 * Restore each env var to its captured original (or delete when unset).
 *
 * @param name The env var name.
 * @param original The captured pre-test value (or undefined to delete).
 */
export function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/** Mock gitleaks as present so its probe succeeds in the healthy-host tests. */
export function mockGitleaksPresent(): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof cpModule>();
    return {
      ...actual,
      execFileSync: vi.fn(
        (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
          if (bin === 'gitleaks' && args[0] === 'version') {
            return Buffer.from('v8.18.2\n');
          }
          return actual.execFileSync(bin, args, opts);
        },
      ),
    };
  });
  vi.resetModules();
}
