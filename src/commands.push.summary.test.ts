import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errOutput,
  logOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as utilsModule from './utils.ts';

// Coverage for cmdPush's emitSummary terminator lines on the success,
// clean, dry-run, and nothing-to-commit paths. Shares the cmdPush pipeline
// harness (makePushEnv) with the boundary-gate suite.
describe('cmdPush Phase 3 push-boundary safety', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('Test 6: cmdPush emits the unmapped-on-push summary line after push complete', async () => {
    // remapPush stubbed to report 1 unmapped + 0 collisions. The summary line
    // MUST appear AFTER `push complete` and reflect both counts.
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
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 1, collisions: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    // `push complete` goes to log (stdout); the unmapped-style summary now
    // goes through warn() (stderr / console.error).
    expect(errOutput(env)).toContain(
      '⚠︎ summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(logOutput(env)).toContain('push complete');
    vi.doUnmock('./remap.ts');
  });

  it('Test 7: cmdPush emits the clean summary line on a successful push with zero unmapped and zero collisions', async () => {
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
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(logOutput(env)).toMatch(/✓ +summary: clean/);
    vi.doUnmock('./remap.ts');
  });

  it('Test 8: cmdPush emits the summary line on the nothing-to-commit early-return path', async () => {
    // gitStatusPorcelainZ returns empty, triggering the `log('nothing to
    // commit'); return;` branch. remapPush has already run, so its counts
    // are in scope. The summary line MUST still appear so users see a
    // consistent terminator even on no-op pushes.
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
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(() => {
        /* no-op success */
      }),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 3, collisions: 0 })),
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ''),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    expect(logOutput(env)).toContain('nothing to commit');
    // unmapped-style summary now goes to warn() (console.error).
    expect(errOutput(env)).toContain(
      '⚠︎ summary: 3 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    vi.doUnmock('./remap.ts');
  });
});
