import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  logOutput,
  makePushEnv,
  teardownPushEnv,
  type PushEnv,
} from './commands.push.test-helpers.ts';

import type * as childProcessModule from 'node:child_process';
import type * as pushChecksModule from './push-checks.ts';
import type * as pushGlobalConfigModule from './push-global-config.ts';
import type * as leakVerdictModule from './push-leak-verdict.ts';
import type * as pushManifestModule from './push-manifest.ts';
import type * as recoveryModule from './commands.push.recovery.ts';
import type * as utilsModule from './utils.ts';
import type { PushState } from './commands.push.sections.ts';
import type { Manifest } from './push-manifest.ts';

/**
 * Behavior tests for `commitAndPush`'s `render` flag (the compose-mode seam
 * `nomad sync` uses) and for `runPushCore({ compose: true })`. Standalone
 * push output (render: true / no compose flag) is asserted byte-compatible
 * by the pre-existing suites in commands.push.test.ts; these tests cover the
 * new render-suppression and section-return behavior.
 */

/** Loose leak-verdict shape shared by the clean and leaky fixtures. */
type TestVerdict = { leak: boolean; verdictRow: string; recovery: string | null; findings: [] };

/** A minimal clean `LeakVerdict` for the no-leak paths. */
const CLEAN_VERDICT: TestVerdict = {
  leak: false,
  verdictRow: '✓ no leaks',
  recovery: null,
  findings: [],
};

/** Build a minimal wet `PushState` with one pushed session row. */
function makeState(): PushState {
  return {
    dryRun: false,
    remap: { unmapped: 0, collisions: 0, pushed: ['proj-a'], wouldPush: [] },
    extras: { unmapped: 0, skipped: 0, pushed: [], wouldPush: [] },
    globalConfig: [],
  };
}

/** An empty manifest fixture for `commitAndPush`'s post-push persist step. */
const EMPTY_MANIFEST = { files: {} } as unknown as Manifest;

/** Default non-interactive resolution (no redact/allow flags). */
const NO_RESOLUTION = { redactAll: false, allowAll: false, allowRule: undefined };

/**
 * Mock the modules `commitAndPush` touches so it runs without a real git
 * repo: git plumbing is a no-op, the staged scan returns `statusLine`, the
 * leak scan returns `verdict`, and the manifest write / global-config
 * collection are stubbed.
 */
function mockCommitDeps(opts: {
  statusLine: string;
  verdict?: TestVerdict;
  resolveSpy?: ReturnType<typeof vi.fn>;
}): void {
  vi.doMock('./utils.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof utilsModule>();
    return {
      ...actual,
      gitOrFatal: vi.fn(),
      gitStatusPorcelainZ: vi.fn(() => opts.statusLine),
    };
  });
  vi.doMock('./push-manifest.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushManifestModule>();
    return { ...actual, writeManifest: vi.fn() };
  });
  vi.doMock('./push-global-config.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushGlobalConfigModule>();
    return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
  });
  vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof leakVerdictModule>();
    return { ...actual, scanPushVerdict: vi.fn(() => opts.verdict ?? CLEAN_VERDICT) };
  });
  if (opts.resolveSpy !== undefined) {
    vi.doMock('./commands.push.recovery.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof recoveryModule>();
      return { ...actual, resolveLeakFindings: opts.resolveSpy };
    });
  }
}

/** Unmock the modules `mockCommitDeps` mocks beyond `teardownPushEnv`'s list. */
function unmockCommitDeps(): void {
  vi.doUnmock('./push-manifest.ts');
  vi.doUnmock('./push-global-config.ts');
  vi.doUnmock('./commands.push.recovery.ts');
}

describe('commitAndPush render flag', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
    unmockCommitDeps();
  });

  it('render: false on a clean push renders nothing and returns the push tree sections', async () => {
    mockCommitDeps({ statusLine: 'M  shared/CLAUDE.md\0' });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome, sections } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      false,
    );
    expect(outcome).toBe('pushed');
    const headers = sections.map((s) => s.header);
    expect(headers).toContain('Sessions');
    expect(headers).toContain('Leak scan');
    expect(headers).toContain('Push summary');
    // Nothing rendered: the composing caller owns the merged tree.
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('render: true on a clean push renders the tree inline and still returns the sections', async () => {
    mockCommitDeps({ statusLine: 'M  shared/CLAUDE.md\0' });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome, sections } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      true,
    );
    expect(outcome).toBe('pushed');
    expect(sections.map((s) => s.header)).toContain('Push summary');
    const combined = logOutput(env);
    expect(combined).toContain('proj-a');
    expect(combined).toContain('Push summary');
  });

  it('render: false on the gsd-only no-op suppresses the "nothing to commit" log and returns no-scan sections', async () => {
    mockCommitDeps({ statusLine: 'M  shared/hooks/gsd-prompt-guard.js\0' });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome, sections } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      false,
    );
    expect(outcome).toBe('nothing');
    expect(sections.map((s) => s.header)).toContain('Push summary');
    expect(logOutput(env)).not.toContain('nothing to commit');
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('render: true on the gsd-only no-op logs "nothing to commit" and renders the no-scan tree', async () => {
    mockCommitDeps({ statusLine: 'M  shared/hooks/gsd-prompt-guard.js\0' });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      true,
    );
    expect(outcome).toBe('nothing');
    const combined = logOutput(env);
    expect(combined).toContain('nothing to commit');
    expect(combined).toContain('Push summary');
  });

  it('the leak path renders the tree inline BEFORE recovery even under render: false, and returns empty sections', async () => {
    const leakVerdict: TestVerdict = {
      leak: true,
      verdictRow: '✗ 1 leak found',
      recovery: 'recovery body',
      findings: [],
    };
    let logCallsAtRecovery = -1;
    const resolveSpy = vi.fn(() => {
      // Snapshot how much had rendered when the recovery flow was entered:
      // the leak tree must already be on screen.
      logCallsAtRecovery = env.logSpy.mock.calls.length;
      return CLEAN_VERDICT;
    });
    mockCommitDeps({
      statusLine: 'M  shared/CLAUDE.md\0',
      verdict: leakVerdict,
      resolveSpy,
    });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome, sections } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      false,
    );
    expect(outcome).toBe('pushed');
    expect(resolveSpy).toHaveBeenCalledOnce();
    // The pre-recovery tree rendered inline before resolveLeakFindings ran.
    expect(logCallsAtRecovery).toBeGreaterThan(0);
    expect(logOutput(env)).toContain('✗ 1 leak found');
    // The compose-mode context header attributes the detached inline trees.
    expect(logOutput(env)).toContain('push (leak recovery)');
    // The resolved tree also rendered inline; the caller gets no sections so
    // a composing caller cannot double-render.
    expect(logOutput(env)).toContain('✓ no leaks');
    expect(sections).toEqual([]);
  });

  it('the leak path under render: true prints no compose-mode context header', async () => {
    const leakVerdict: TestVerdict = {
      leak: true,
      verdictRow: '✗ 1 leak found',
      recovery: 'recovery body',
      findings: [],
    };
    const resolveSpy = vi.fn(() => CLEAN_VERDICT);
    mockCommitDeps({
      statusLine: 'M  shared/CLAUDE.md\0',
      verdict: leakVerdict,
      resolveSpy,
    });
    const { commitAndPush } = await import('./commands.push.steps.ts');
    const { outcome } = await commitAndPush(
      makeState(),
      'ts',
      { projects: {} },
      NO_RESOLUTION,
      env.repoUnderHome,
      EMPTY_MANIFEST,
      true,
    );
    expect(outcome).toBe('pushed');
    const combined = logOutput(env);
    expect(combined).toContain('✗ 1 leak found');
    // Standalone push already printed its own header; no extra context line.
    expect(combined).not.toContain('push (leak recovery)');
  });
});

// ---------------------------------------------------------------------------
// runPushCore compose mode
// ---------------------------------------------------------------------------

/**
 * Mock the full push pipeline so `runPushCore` runs end to end in the
 * sandbox: safety probes stubbed, remap/extras return empty results, git
 * status returns `statusLine`, git plumbing is intercepted at
 * node:child_process, and the leak scan returns clean.
 *
 * `opts.revListCount` sets the stdout of the ahead-of-upstream
 * `git rev-list --count` probe (defaults to `'0\n'`, i.e. not ahead);
 * `opts.revListFails: true` makes that probe throw instead (no upstream
 * configured).
 */
function mockPipeline(
  statusLine: string,
  opts: { revListCount?: string; revListFails?: boolean } = {},
): void {
  vi.doMock('./push-checks.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushChecksModule>();
    return {
      ...actual,
      probeGitleaks: vi.fn(() => 'v8.18.2'),
      rebaseBeforePush: vi.fn(),
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
  vi.doMock('./skills-sync.ts', () => ({
    syncSkillsPush: vi.fn(),
    copySkillsPull: vi.fn(),
  }));
  // links.ts is deliberately NOT mocked: syncSharedLinksPush is a win32-only
  // mirror and returns immediately on the darwin/linux test hosts.
  vi.doMock('./push-manifest.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushManifestModule>();
    return {
      ...actual,
      readManifest: vi.fn(() => null),
      writeManifest: vi.fn(),
      computeConfigHash: vi.fn(() => 'testhash'),
    };
  });
  vi.doMock('./push-global-config.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof pushGlobalConfigModule>();
    return { ...actual, collectGlobalConfigChanges: vi.fn(() => []) };
  });
  vi.doMock('./push-leak-verdict.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof leakVerdictModule>();
    return { ...actual, scanPushVerdict: vi.fn(() => CLEAN_VERDICT) };
  });
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof childProcessModule>();
    return {
      ...actual,
      execFileSync: vi.fn((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'rev-list') {
          if (opts.revListFails === true) throw new Error('no upstream configured');
          return Buffer.from(opts.revListCount ?? '0\n');
        }
        return Buffer.from('');
      }),
    };
  });
  vi.doMock('./utils.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof utilsModule>();
    return { ...actual, gitStatusPorcelainZ: vi.fn(() => statusLine) };
  });
}

describe('runPushCore compose mode', () => {
  let env: PushEnv;

  beforeEach(() => {
    env = makePushEnv();
  });

  afterEach(() => {
    teardownPushEnv(env);
    unmockCommitDeps();
  });

  it('compose: true on a clean "nothing to commit" run suppresses the header and log, renders nothing, and returns sections', async () => {
    mockPipeline('');
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore({ compose: true });
    expect(result.tag).toBe('nothing');
    if (result.tag !== 'nothing') throw new Error('unreachable');
    expect(result.sections?.map((s) => s.header)).toContain('Push summary');
    expect(result.aheadOfOrigin).toBe(false);
    expect(logOutput(env)).not.toContain('push on host=');
    expect(logOutput(env)).not.toContain('nothing to commit');
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('compose: true empty-status carries aheadOfOrigin: true when HEAD has commits upstream lacks', async () => {
    mockPipeline('', { revListCount: '2\n' });
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore({ compose: true });
    expect(result.tag).toBe('nothing');
    if (result.tag !== 'nothing') throw new Error('unreachable');
    expect(result.aheadOfOrigin).toBe(true);
    // The probe itself never prints.
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('compose: true empty-status treats a failing ahead-of-upstream probe as not ahead', async () => {
    mockPipeline('', { revListFails: true });
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore({ compose: true });
    expect(result.tag).toBe('nothing');
    if (result.tag !== 'nothing') throw new Error('unreachable');
    expect(result.aheadOfOrigin).toBe(false);
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('compose: true on the gsd-only no-op carries aheadOfOrigin from the upstream probe', async () => {
    mockPipeline('M  shared/hooks/gsd-prompt-guard.js\0', { revListCount: '1\n' });
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore({ compose: true });
    expect(result.tag).toBe('nothing');
    if (result.tag !== 'nothing') throw new Error('unreachable');
    expect(result.sections?.map((s) => s.header)).toContain('Push summary');
    expect(result.aheadOfOrigin).toBe(true);
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('compose: true on a real push returns { tag: "pushed", sections } and renders nothing itself', async () => {
    mockPipeline('M  shared/CLAUDE.md\0');
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore({ compose: true });
    expect(result.tag).toBe('pushed');
    if (result.tag !== 'pushed') throw new Error('unreachable');
    const headers = result.sections?.map((s) => s.header) ?? [];
    expect(headers).toContain('Leak scan');
    expect(headers).toContain('Push summary');
    expect(logOutput(env)).not.toContain('push on host=');
    expect(env.logSpy).not.toHaveBeenCalled();
  });

  it('no compose flag stays byte-identical: header, "nothing to commit" log, and inline tree all print', async () => {
    mockPipeline('');
    const { runPushCore } = await import('./commands.push.ts');
    const result = await runPushCore();
    expect(result).toEqual({ tag: 'nothing' });
    const combined = logOutput(env);
    expect(combined).toContain('push on host=');
    expect(combined).toContain('nothing to commit');
    expect(combined).toContain('Push summary');
  });
});
