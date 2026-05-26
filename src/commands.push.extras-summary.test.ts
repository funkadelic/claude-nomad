import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// cmdPush emitSummary aggregation on the clean push success path: session and
// extras unmapped counts combine into one WARN line, and extras-skipped
// surfaces its own suffix. Shares the cmdPush pipeline harness (makePushEnv)
// with the extras-integration suite.
describe('cmdPush: extras pipeline integration', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('combines remapResult.unmapped + extrasResult.unmapped in the post-push success summary', async () => {
    // Regression pin for the 3-site emitSummary contract: the post-commit
    // success path historically only passed remapResult.unmapped, silently
    // dropping TBD-host extras from the user-visible WARN. With 2 session
    // unmapped + 3 extras unmapped, the combined "5 unmapped on push" must
    // appear in the WARN summary line.
    writeFileSync(
      join(env.repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: {} }) + '\n',
    );
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({ runGitleaksScan: vi.fn() }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 2, collisions: 0 })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 3, skipped: 0 })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
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
      return { ...actual, execFileSync: vi.fn(() => Buffer.from('')) };
    });
    const { cmdPush } = await import('./commands.push.ts');
    expect(() => cmdPush()).not.toThrow();
    // push complete log line confirms we reached the success path (not the
    // empty-status or dry-run branches whose own coverage exists elsewhere).
    expect(logOutput(env)).toContain('push complete');
    expect(errOutput(env)).toContain('5 unmapped on push');
  });

  it('surfaces extrasResult.skipped to emitSummary on the clean push success path', async () => {
    // skipped=2 from remapExtrasPush should produce the new
    // "2 extras skipped" suffix on the push WARN line.
    writeFileSync(
      join(env.repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { foo: ['node_modules', '.planning'] } }) + '\n',
    );
    vi.doMock('./push-checks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushChecksModule>();
      return {
        ...actual,
        probeGitleaks: vi.fn(() => 'v8.18.2'),
        rebaseBeforePush: vi.fn(() => {
          /* no-op */
        }),
        findGitlinks: vi.fn(() => []),
      };
    });
    vi.doMock('./push-gitleaks.ts', () => ({
      runGitleaksScan: vi.fn(),
    }));
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0 })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 0, skipped: 2 })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
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
    expect(errOutput(env)).toContain('2 extras skipped');
  });
});
