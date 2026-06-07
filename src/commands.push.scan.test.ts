import { existsSync, rmSync } from 'node:fs';
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
import type * as pushPreviewModule from './push-preview.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as utilsModule from './utils.ts';

// Coverage for cmdPush's gitleaks-scan stage: a detection on the staged tree
// unwinds to a FATAL with the lock released, and the dry-run path skips the
// scan (and the rest of the staging quartet) entirely. Shares the cmdPush
// pipeline harness (makePushEnv) with the boundary-gate suite.
describe('cmdPush Phase 3 push-boundary safety', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
  });

  it('Test 5: gitleaks detection on scan -> tree renders the ✗ Leak scan row, recovery block prints below, FATAL exit, lock released', async () => {
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
    // cmdPush now calls scanPushVerdict (which RETURNS the verdict) instead of
    // runGitleaksScan (which threw). Mock it to return a leak verdict: cmdPush
    // renders the ✗ Leak scan row, then re-raises the recovery body as a FATAL.
    vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof leakVerdictModule>();
      return {
        ...actual,
        scanPushVerdict: vi.fn(() => ({
          leak: true,
          verdictRow: actual.failRow('gitleaks detected secrets in 1 session transcript(s)'),
          recovery:
            'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry',
          findings: [],
        })),
      };
    });
    // Make gitStatusPorcelainZ report a single allow-listed modification so
    // the flow reaches the scan step (the early-return short-circuit only
    // fires on an empty index).
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => 'M  shared/CLAUDE.md\0'),
      };
    });
    // The temp REPO is not a real git repo, so the inline `git add -A` would
    // fail before the scan step. Mock node:child_process so all execFileSync
    // calls become deterministic no-ops returning an empty Buffer.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    // The one-line ✗ verdict row renders in the tree (stdout)...
    expect(logOutput(env)).toContain('Leak scan');
    expect(logOutput(env)).toMatch(/gitleaks detected secrets in 1 session transcript/);
    // ...and the recovery block prints below the tree via fail() (stderr).
    expect(errOutput(env)).toMatch(/gitleaks detected secrets/);
    vi.doUnmock('./push-leak-verdict.ts');
  });

  it('Test 8a: cmdPush({ dryRun: true }) skips git add / commit / push, runs leak preview, and renders the dry-run tree', async () => {
    // Dry-run preview: probeGitleaks + rebase + remap (in dryRun) + gitlink
    // scan + status read + allow-list classification all run. git add /
    // git commit / git push are skipped. previewPushLeaks runs as a
    // read-only leak preview (mocked here to return a clean verdict to keep
    // this a pure pipeline test). The grouped tree (header + Leak scan +
    // Summary) terminates the run.
    const scanPushVerdictMock = vi.fn(() => {
      /* should not be invoked directly on the dry-run path */
    });
    const previewPushLeaksMock = vi.fn(() => ({
      leak: false,
      verdictRow: '✓ no leaks',
      recovery: null,
    }));
    const gitOrFatalMock = vi.fn(() => {
      /* should not be invoked for add/commit/push */
    });
    const remapPushMock = vi.fn(() => ({ unmapped: 2, collisions: 0, pushed: [], wouldPush: [] }));
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
      return { ...actual, scanPushVerdict: scanPushVerdictMock };
    });
    vi.doMock('./push-preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushPreviewModule>();
      return { ...actual, previewPushLeaks: previewPushLeaksMock };
    });
    vi.doMock('./remap.ts', () => ({
      remapPull: vi.fn(),
      remapPush: remapPushMock,
    }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        // Non-empty status: the dryRun branch should fire AFTER the
        // allow-list pass, not bypass the early-return-on-empty path.
        gitStatusPorcelainZ: vi.fn(() => ' M shared/CLAUDE.md\0'),
        gitOrFatal: gitOrFatalMock,
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(existsSync(env.lockPath)).toBe(false);
    // remapPush received { dryRun: true } so no host-encoded copies landed.
    expect(remapPushMock).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
    // scanPushVerdict (the real-push scan) must NOT run on the dry-run path.
    expect(scanPushVerdictMock).not.toHaveBeenCalled();
    // previewPushLeaks MUST be called.
    expect(previewPushLeaksMock).toHaveBeenCalledOnce();
    // git add / commit / push skipped.
    expect(gitOrFatalMock).not.toHaveBeenCalled();
    const out = logOutput(env);
    // The dry-run header is now the tree header (no ℹ︎ prefix).
    expect(out).toContain('push on host=test-host (dry-run)');
    // The Leak scan section renders the preview's clean verdict row.
    expect(out).toContain('Leak scan');
    expect(out).toMatch(/no leaks/);
    // The Summary row carries the combined unmapped count.
    expect(out).toContain('Summary');
    expect(out).toContain('2 unmapped on push, 0 collisions (run nomad doctor to list)');
    expect(out).not.toContain('push complete');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-leak-verdict.ts');
  });

  it('Test 8b: dry-run preview leak renders the ✗ Leak scan row and prints the recovery block below the tree', async () => {
    // previewPushLeaks returns a leak verdict (leak=true, recovery set). cmdPush
    // renders the tree with the ✗ Leak scan row, then prints recovery below via
    // fail() (stderr). The dry-run path never throws; exitCode is set by the
    // preview itself (mocked here, so we only assert the recovery print path).
    const previewPushLeaksMock = vi.fn(() => ({
      leak: true,
      verdictRow: '✗ gitleaks detected secrets in 1 session transcript(s)',
      recovery: 'Session abc12345:\n  Recover with: nomad drop-session abc12345',
    }));
    const remapPushMock = vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] }));
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
    vi.doMock('./push-preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushPreviewModule>();
      return { ...actual, previewPushLeaks: previewPushLeaksMock };
    });
    vi.doMock('./remap.ts', () => ({ remapPull: vi.fn(), remapPush: remapPushMock }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return {
        ...actual,
        gitStatusPorcelainZ: vi.fn(() => ' M shared/CLAUDE.md\0'),
      };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    expect(previewPushLeaksMock).toHaveBeenCalledOnce();
    // The ✗ one-line verdict row renders in the tree (stdout).
    expect(logOutput(env)).toMatch(/gitleaks detected secrets in 1 session transcript/);
    // The recovery block prints below the tree via fail() (stderr).
    expect(errOutput(env)).toContain('nomad drop-session abc12345');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-preview.ts');
  });

  it('Test 8c: dry-run on a CLEAN repo (empty status) with a planted leak runs the preview, renders ✗, and sets exitCode 1', async () => {
    // WR-03: the empty-status early return is now real-push-only, so a dry-run
    // on a clean repo (gitStatusPorcelainZ -> '') still reaches the leak
    // preview. previewPushLeaks is mocked to a leak verdict AND sets
    // process.exitCode=1 inside the mock so the assertion mirrors production
    // (the real fn sets it via verdictFromFindings).
    const previewPushLeaksMock = vi.fn(() => {
      process.exitCode = 1;
      return {
        leak: true,
        verdictRow: '✗ gitleaks detected secrets in 1 session transcript(s)',
        recovery: 'Session abc12345:\n  Recover with: nomad drop-session abc12345',
      };
    });
    const remapPushMock = vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] }));
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
    vi.doMock('./push-preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushPreviewModule>();
      return { ...actual, previewPushLeaks: previewPushLeaksMock };
    });
    vi.doMock('./remap.ts', () => ({ remapPull: vi.fn(), remapPush: remapPushMock }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      // Empty status: the clean-repo headline case. The dry-run preview MUST
      // still run despite the empty index.
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    // The clean-repo early return did NOT fire: the preview ran.
    expect(previewPushLeaksMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(existsSync(env.lockPath)).toBe(false);
    // The ✗ verdict row renders in the tree (stdout); recovery prints below (stderr).
    expect(logOutput(env)).toMatch(/gitleaks detected secrets in 1 session transcript/);
    expect(errOutput(env)).toContain('nomad drop-session abc12345');
    // The clean-repo real-push terminator must NOT appear on the dry-run path.
    expect(logOutput(env)).not.toContain('nothing to commit');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-preview.ts');
  });

  it('Test 8d: dry-run on a CLEAN repo with a clean mapped session shows the ✓ no-leaks verdict and leaves exitCode unset', async () => {
    // WR-03 clean variant: empty status, previewPushLeaks returns the clean
    // verdict. No recovery, no exitCode bump.
    const previewPushLeaksMock = vi.fn(() => ({
      leak: false,
      verdictRow: '✓ no leaks',
      recovery: null,
    }));
    const remapPushMock = vi.fn(() => ({ unmapped: 0, collisions: 0, pushed: [], wouldPush: [] }));
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
    vi.doMock('./push-preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushPreviewModule>();
      return { ...actual, previewPushLeaks: previewPushLeaksMock };
    });
    vi.doMock('./remap.ts', () => ({ remapPull: vi.fn(), remapPush: remapPushMock }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    expect(previewPushLeaksMock).toHaveBeenCalledOnce();
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    const out = logOutput(env);
    expect(out).toContain('Leak scan');
    expect(out).toMatch(/no leaks/);
    // No recovery body on a clean preview.
    expect(errOutput(env)).not.toContain('nomad drop-session');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-preview.ts');
  });

  it('Test 8e: dry-run with NO path-map on a clean repo renders the no-scan tree, does not die, and never calls previewPushLeaks', async () => {
    // WR-03 no-map variant: a dry-run with an empty status and no path-map.json
    // must render the no-scan tree and return WITHOUT dying (a real push with a
    // non-empty status still dies on the missing map; covered elsewhere).
    const previewPushLeaksMock = vi.fn(() => ({
      leak: false,
      verdictRow: '✓ no leaks',
      recovery: null,
    }));
    const remapPushMock = vi.fn(() => ({ unmapped: 1, collisions: 0, pushed: [], wouldPush: [] }));
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
    vi.doMock('./push-preview.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof pushPreviewModule>();
      return { ...actual, previewPushLeaks: previewPushLeaksMock };
    });
    vi.doMock('./remap.ts', () => ({ remapPull: vi.fn(), remapPush: remapPushMock }));
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, gitStatusPorcelainZ: vi.fn(() => '') };
    });
    // Remove the default path-map.json the harness wrote.
    rmSync(join(env.repoUnderHome, 'path-map.json'));
    const { cmdPush } = await import('./commands.push.ts');
    await cmdPush({ dryRun: true });
    // No die: the lock released and exitCode stayed clean.
    expect(existsSync(env.lockPath)).toBe(false);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    // previewPushLeaks is NOT reached when there is no map to stage from.
    expect(previewPushLeaksMock).not.toHaveBeenCalled();
    const out = logOutput(env);
    // The no-scan tree renders (Summary, no Leak scan section) with the
    // no-path-map hint so the user sees why nothing was scanned.
    expect(out).toContain('Summary');
    expect(out).not.toContain('Leak scan');
    expect(out).toContain('no path-map.json');
    // The missing-map FATAL did NOT fire.
    expect(errOutput(env)).not.toContain('path-map.json missing');
    vi.doUnmock('./remap.ts');
    vi.doUnmock('./push-preview.ts');
  });
});
