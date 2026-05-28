import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as utilsModule from './utils.ts';

// Coverage for cmdPush's failure-path terminators: the repo-absent
// precondition (fatal before lock acquisition), the singular/plural
// gitlink-count wording, and end-to-end propagation of a session-aware
// gitleaks NomadFatal through the command boundary. Shares the cmdPush
// pipeline harness (makePushEnv) with the boundary-gate suite.
describe('cmdPush Phase 3 push-boundary safety', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('Test 9: cmdPush dies with "repo not cloned at" FATAL when REPO_HOME absent (no lockfile created)', async () => {
    // Remove the repo dir created by makePushEnv so the precondition
    // (`if (!existsSync(REPO_HOME))`) fires BEFORE acquireLock. Critical: no
    // lockfile must land on disk because the precondition is before the lock
    // acquisition. The precondition uses `die` which throws NomadFatal; the
    // current cmdPush body only catches inside the try block (which is AFTER
    // acquireLock), so this fatal escapes to the test as a thrown error.
    rmSync(env.repoUnderHome, { recursive: true, force: true });
    expect(existsSync(env.repoUnderHome)).toBe(false);
    const { cmdPush } = await import('./commands.push.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => cmdPush()).toThrow(NomadFatal);
    expect(() => cmdPush()).toThrow(/repo not cloned at/);
    expect(existsSync(env.lockPath)).toBe(false);
  });

  it('Test 10: cmdPush reports plural "entries" when findGitlinks returns 2 or more hits', async () => {
    // Mirror Test 4 (singular "entry") but return two gitlink hits. The
    // summary throw uses `count === 1 ? 'entry' : 'entries'`; the plural
    // branch was previously uncovered.
    const hit1 = join(env.repoUnderHome, 'shared', 'a', '.git');
    const hit2 = join(env.repoUnderHome, 'shared', 'b', '.git');
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => [hit1, hit2]),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    const out = errOutput(env);
    // Per-hit lines for both, plus the plural summary FATAL.
    expect(out).toMatch(/gitlink: shared\/a\/\.git/);
    expect(out).toMatch(/gitlink: shared\/b\/\.git/);
    expect(out).toMatch(/gitlink trap: 2 nested \.git entries in shared\//);
  });

  it('gitleaks detection on a session JSONL -> tree ✗ row + recovery block names the session id and drop-session hint; lock released', async () => {
    // Session-aware end-to-end: scanPushVerdict RETURNS a leak verdict whose
    // recovery body names a synthetic session id + drop-session hint. cmdPush
    // renders the tree (✗ Leak scan row to stdout), then re-raises the recovery
    // body as a NomadFatal; the catch routes it through console.error with the
    // ✗ prefix, sets exitCode=1, and the finally releases the lock. The unit
    // tests in push-gitleaks.test.ts cover the builder shape; this asserts the
    // recovery body propagates through the command boundary intact.
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op success */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return {
        ...actual,
        scanPushVerdict: vi.fn(() => ({
          leak: true,
          verdictRow: actual.failRow('gitleaks detected secrets in 1 session transcript(s)'),
          recovery: [
            'gitleaks detected secrets in 1 session transcript(s).',
            '',
            'Session abc12345-test-fixture:',
            '  generic-api-key (1)',
            '  Recover with: nomad drop-session abc12345-test-fixture',
            '',
            'After recovery, re-run nomad push.',
          ].join('\n'),
        })),
      };
    });
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Non-empty status so the flow reaches the scan step.
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/projects/foo/sid.jsonl\0'),
      };
    });
    // The temp REPO is not a real git repo, so the inline `git add -A`
    // would fail before the scan step. Mock node:child_process so all
    // execFileSync calls become deterministic no-ops returning empty.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    // path-map.json must reference the logical so enforceAllowList does
    // not reject `shared/projects/foo/sid.jsonl` before the scan runs.
    writeFileSync(
      join(env.repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    // The recovery block prints below the tree via fail() (stderr, ✗ prefix).
    const out = errOutput(env);
    expect(out).toContain('✗ ');
    expect(out).toContain('abc12345-test-fixture');
    expect(out).toContain('nomad drop-session');
    vi.doUnmock('./push-leak-verdict.ts');
  });
});
