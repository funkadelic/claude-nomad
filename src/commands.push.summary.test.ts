import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  logOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
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

  it('Test 6: cmdPush renders the unmapped-on-push summary row in the tree on a clean-scan success', async () => {
    // remapPush stubbed to report 1 unmapped + 0 collisions. The Summary
    // section row reflects both counts and the Leak scan row shows no leaks.
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
        scanPushVerdict: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
      };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 1, collisions: 0, pushed: [], wouldPush: [] })),
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
    // The Summary section row now renders inside the tree (stdout); the
    // standalone `push complete` line is gone.
    const out = logOutput(env);
    expect(out).toContain('Summary');
    expect(out).toContain('1 unmapped on push, 0 collisions (run nomad doctor to list)');
    expect(out).toContain('Leak scan');
    expect(out).toMatch(/no leaks/);
    expect(out).not.toContain('push complete');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-leak-verdict.ts');
  });

  it('Test 7: cmdPush renders the clean summary row in the tree on a zero-unmapped, zero-collision push', async () => {
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
        scanPushVerdict: vi.fn(() => ({ leak: false, verdictRow: '✓ no leaks', recovery: null })),
      };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({
        unmapped: 0,
        collisions: 0,
        pushed: ['my-project'],
        wouldPush: [],
      })),
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
    const out = logOutput(env);
    // The clean Summary row renders inside the tree (stdout) as plain text.
    expect(out).toContain('clean');
    // The pushed session shows as a ✓ row under the Sessions section.
    expect(out).toContain('Sessions');
    expect(out).toMatch(/✓ +my-project/);
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-leak-verdict.ts');
  });

  it('Test 8: cmdPush renders the nothing-to-commit tree (Summary row, no Leak scan section)', async () => {
    // gitStatusPorcelainZ returns empty, triggering the `log('nothing to
    // commit')` + no-scan tree branch. remapPush has already run, so its
    // counts are in scope. The Summary row MUST still appear so users see a
    // consistent terminator even on no-op pushes; the Leak scan section is
    // absent (nothing staged to scan).
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
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 3, collisions: 0, pushed: [], wouldPush: [] })),
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
    const out = logOutput(env);
    expect(out).toContain('nothing to commit');
    // The Summary row renders in-tree (stdout). With 3 unmapped sessions the
    // Sessions section shows the collapsed count row.
    expect(out).toContain('Summary');
    expect(out).toContain('3 unmapped on push, 0 collisions (run nomad doctor to list)');
    expect(out).toContain('Sessions');
    expect(out).toContain('3 not in path-map (run nomad doctor to list)');
    // No staging happened, so there is no Leak scan section.
    expect(out).not.toContain('Leak scan');
    vi.doUnmock('./remap.ts');
  });

  it('Test 8b: nothing-to-commit with zero pushed AND zero unmapped omits the Sessions header', async () => {
    // Empty-section omission: pushed=[] AND unmapped==0 (and no extras) means
    // renderTree skips the empty Sessions/Extras headers; only the Summary row
    // (✓ clean) prints. Covers the renderTree empty-section branch.
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
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] })),
    }));
    vi.doMock('./extras-sync.ts', () => ({
      remapExtrasPush: vi.fn(() => ({ unmapped: 0, skipped: 0, pushed: [], wouldPush: [] })),
      remapExtrasPull: vi.fn(),
      divergenceCheckExtras: vi.fn(),
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
    const out = logOutput(env);
    expect(out).toContain('nothing to commit');
    // Empty Sessions/Extras sections are omitted by renderTree.
    expect(out).not.toContain('Sessions');
    expect(out).not.toContain('Extras');
    // Only the clean Summary row remains, rendered as plain text.
    expect(out).toContain('clean');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./extras-sync.ts');
  });
});
