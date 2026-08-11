import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as linksMirrorModule from './links.mirror.ts';

import { SHARED_LINKS } from './config.ts';
import { renderTree } from './output-tree.ts';
import { plantSharedBaseline } from './test-support/baseline.ts';
import { g, gitInit, gitOut } from './test-support/git.ts';
import { stubPlatform } from './test-helpers.platform.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. Gates the backstop
 * describe below, whose fixtures need a real checkout with a commit: the
 * tracked-and-modified case cannot exist without a HEAD to restore from.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Module-level regression cover for the extracted win32 pre-pull reconcile.
 *
 * `commands.pull.test.ts` keeps the runPullCore-level assertions (that seam is
 * still real: the step must run before `git pull --rebase` and must be skipped
 * under dry-run and force-remote). These assert the properties that now live
 * inside the extracted entry point instead: the platform gate, one map read
 * shared by both passes, the pass order, the containment that keeps a pre-step
 * from ever being the thing that fails a pull, and the created-set report it
 * hands back.
 *
 * The created-set probes shell out (`execFileSync` via `gitProbe`), and the
 * fixture repo here is deliberately not a git repo, which is what makes it the
 * right place to pin the degraded answer.
 */
describe('reconcileSharedLinksBeforePull', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  const TS = '20260803-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-reconcile-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(join(repoUnderHome, 'shared'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    // vi.restoreAllMocks does NOT clear doMock registrations, and a leaked one
    // fails an unrelated test in a different file in the same worker.
    vi.doUnmock('./links.mirror.ts');
    vi.doUnmock('./links.deletions.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Mock both passes, recording each call into one shared ordering log.
   *
   * The order claim needs a call-order instrument rather than an effect
   * assertion: both passes write into the same `shared/` tree, so their effects
   * alone cannot say which ran first.
   *
   * @param order - Array appended to on each mocked call.
   * @returns The two spies, for argument assertions.
   */
  function mockPasses(order: string[]): {
    mirror: ReturnType<typeof vi.fn>;
    deletions: ReturnType<typeof vi.fn>;
  } {
    const mirror = vi.fn(() => {
      order.push('mirror');
    });
    const deletions = vi.fn(() => {
      order.push('deletions');
    });
    // Spread the real module rather than replacing it outright: the denylist
    // backstop below (revertDeniedUnderShared) reaches revertDeniedMirrorPaths
    // outside this function's try/catch, and a bare `{ stageLocalSharedEdits }`
    // factory leaves that export undefined, only silently inert here because
    // these fixtures are not git checkouts (gitProbe returns null first).
    vi.doMock('./links.mirror.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof linksMirrorModule>();
      return { ...actual, stageLocalSharedEdits: mirror };
    });
    vi.doMock('./links.deletions.ts', () => ({ applySharedLinkDeletions: deletions }));
    return { mirror, deletions };
  }

  /**
   * Assert the mirror spy's first call matches `(map, ts, { onPreview: <fn> })`.
   * Written as positional-argument checks rather than
   * `toHaveBeenCalledWith(..., expect.objectContaining(...))` so the untyped
   * `vi.fn()` spy's `any`-typed call args never flow through a nested
   * `expect.any()` matcher, which trips `no-unsafe-assignment`.
   *
   * @param mirror - The mirror spy returned by `mockPasses`.
   * @param map - Expected first argument (the path map passed through).
   * @param ts - Expected second argument (the backup timestamp).
   */
  function expectMirrorCalledWith(
    mirror: ReturnType<typeof vi.fn>,
    map: unknown,
    ts: string,
  ): void {
    const call = mirror.mock.calls[0] as [unknown, unknown, { onPreview?: unknown } | undefined];
    expect(call[0]).toEqual(map);
    expect(call[1]).toBe(ts);
    expect(typeof call[2]?.onPreview).toBe('function');
  }

  /**
   * Assert the deletions spy's first call matches
   * `(map, ts, { linkNames: <expected> })`, again via positional checks
   * rather than a nested `expect.objectContaining`.
   *
   * @param deletions - The deletions spy returned by `mockPasses`.
   * @param map - Expected first argument (the path map passed through).
   * @param ts - Expected second argument (the backup timestamp).
   * @param linkNames - Expected `linkNames` threaded through the third argument.
   */
  function expectDeletionsCalledWith(
    deletions: ReturnType<typeof vi.fn>,
    map: unknown,
    ts: string,
    linkNames: string[],
  ): void {
    const call = deletions.mock.calls[0] as [unknown, unknown, { linkNames?: unknown } | undefined];
    expect(call[0]).toEqual(map);
    expect(call[1]).toBe(ts);
    expect(call[2]?.linkNames).toEqual(linkNames);
  }

  it('runs the mirror before the deletion pass', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);
    expect(order).toEqual(['mirror', 'deletions']);
  });

  it('reads the path map once and hands the same value to both passes', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['extra'] }) + '\n',
    );
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);
    // One read, so the two passes cannot disagree about which names are shared.
    expect(mirror.mock.calls[0]?.[0]).toBe(deletions.mock.calls[0]?.[0]);
    expectMirrorCalledWith(mirror, { projects: {}, sharedDirs: ['extra'] }, TS);
  });

  it('does nothing at all on a posix platform', async () => {
    stubPlatform('linux');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    const { mirrored, events } = reconcileSharedLinksBeforePull(repoUnderHome, TS);
    expect(mirror).not.toHaveBeenCalled();
    expect(deletions).not.toHaveBeenCalled();
    // Nothing was mirrored, so nothing is this run's to account for, and the
    // collision runbook downstream stays entirely out of the posix pull.
    expect(mirrored).toEqual([]);
    expect(events).toEqual([]);
  });

  it('reports no created files when the snapshots cannot be taken', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror } = mockPasses(order);
    mirror.mockImplementation(() => {
      writeFileSync(join(repoUnderHome, 'shared', 'staged.md'), '# staged\n');
    });
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    // The fixture repo is a plain directory, so the probes fail. Attributing
    // every untracked file to this run would be the dangerous reading; the
    // feature turns itself off instead.
    expect(reconcileSharedLinksBeforePull(repoUnderHome, TS).mirrored).toEqual([]);
  });

  it('still runs both passes with the empty map when path-map.json is absent', async () => {
    rmSync(join(repoUnderHome, 'path-map.json'), { force: true });
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);
    // Absent is a valid steady state (a clone that predates init), and the empty
    // map still yields the static shared names.
    expectMirrorCalledWith(mirror, { projects: {} }, TS);
    expectDeletionsCalledWith(deletions, { projects: {} }, TS, [...SHARED_LINKS]);
  });

  it('passes null to both passes on a malformed path-map.json', async () => {
    writeFileSync(join(repoUnderHome, 'path-map.json'), '{ not json\n');
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);
    // Degrades rather than throwing; the post-rebase read still dies loudly.
    expectMirrorCalledWith(mirror, null, TS);
    expectDeletionsCalledWith(deletions, null, TS, []);
  });

  it('warns and returns when the mirror throws, without reaching the deletion pass', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    mirror.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    expect(() => reconcileSharedLinksBeforePull(repoUnderHome, TS)).not.toThrow();
    expect(deletions).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('EPERM');
  });

  it('warns and returns when the deletion pass throws', async () => {
    stubPlatform('win32');
    const order: string[] = [];
    const { deletions } = mockPasses(order);
    deletions.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    // Same containment as the mirror half: aborting here would leave the host
    // unable to fetch at all until the local condition clears, and an
    // unpropagated deletion is simply replanned on the next run.
    expect(() => reconcileSharedLinksBeforePull(repoUnderHome, TS)).not.toThrow();
    expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('EBUSY');
  });
});

/**
 * End-to-end coverage of the tracer path this plan wires: a win32-stubbed
 * capture travels from the host file, through the real (unmocked)
 * `reconcileSharedLinksBeforePull`, into a rendered `Symlinks` row via
 * `buildMirrorSection` + `renderTree`. Neither `links.mirror.ts` nor
 * `links.deletions.ts` is mocked here, unlike the describe block above: this
 * block exists specifically to prove the real mirror's output reaches the
 * real renderer.
 */
describe('reconcileSharedLinksBeforePull -> buildMirrorSection (end-to-end)', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let logSpy: MockInstance<(...args: unknown[]) => void>;
  let errSpy: MockInstance<(...args: unknown[]) => void>;
  const TS = '20260810-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-mirror-e2e-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('renders a captured row end to end', async () => {
    const repoClaudeMd = join(sharedDir, 'CLAUDE.md');
    const localClaudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(repoClaudeMd, '# repo copy\n');
    writeFileSync(localClaudeMd, '# host edit\n');

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull, buildMirrorSection } =
      await import('./commands.pull.win32.ts');
    const { events } = reconcileSharedLinksBeforePull(repoUnderHome, TS);

    expect(events).toEqual([
      { kind: 'mirror', name: 'CLAUDE.md', localPath: localClaudeMd, repoPath: repoClaudeMd },
    ]);
    expect(readFileSync(repoClaudeMd, 'utf8')).toBe('# host edit\n');

    renderTree([buildMirrorSection(events)]);
    const rendered = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(rendered).toContain('Symlinks');
    expect(rendered).toContain(localClaudeMd);
    expect(rendered).toContain(repoClaudeMd);
  });

  it('leaves the repo-side file byte-unchanged under dryRun while still producing the event', async () => {
    const repoClaudeMd = join(sharedDir, 'CLAUDE.md');
    const localClaudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(repoClaudeMd, '# repo copy\n');
    writeFileSync(localClaudeMd, '# host edit\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    const events: { name: string }[] = [];
    stageLocalSharedEdits({ projects: {} }, TS, {
      dryRun: true,
      onPreview: (e) => events.push(e),
    });

    expect(events).toEqual([
      { kind: 'mirror', name: 'CLAUDE.md', localPath: localClaudeMd, repoPath: repoClaudeMd },
    ]);
    expect(readFileSync(repoClaudeMd, 'utf8')).toBe('# repo copy\n');
  });

  it('yields an empty Symlinks section on a non-win32 platform, which renderTree omits entirely', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');

    stubPlatform('linux');
    const { reconcileSharedLinksBeforePull, buildMirrorSection } =
      await import('./commands.pull.win32.ts');
    const { events } = reconcileSharedLinksBeforePull(repoUnderHome, TS);
    expect(events).toEqual([]);

    const section = buildMirrorSection(events);
    expect(section.items).toEqual([]);

    renderTree([section]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('warns exactly once for one invalid sharedDirs entry across the pre-rebase reconcile', async () => {
    // Before this fix, mirrorSharedNames (via stageLocalSharedEdits) and
    // planSharedLinkDeletions (via applySharedLinkDeletions) each derived
    // allSharedLinks(map) independently inside this one reconcile step,
    // WARNing twice for the same rejected entry. linkNames is now derived
    // once here and threaded into both.
    //
    // The baseline is what makes this count meaningful. Without one,
    // planSharedLinkDeletions returns before enumerating anything, so the whole
    // deletion half is unreachable and the assertion holds for a reason that has
    // nothing to do with the threading it is meant to pin.
    plantSharedBaseline(testHome);
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);

    const rejectionCalls = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sharedDirs entry'),
    );
    expect(rejectionCalls).toHaveLength(1);
  });

  it('produces zero rejection WARNs for a sharedDirs array with no invalid entries', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['get-shit-done'] }) + '\n',
    );
    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);

    const rejectionCalls = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sharedDirs entry'),
    );
    expect(rejectionCalls).toHaveLength(0);
  });
});

/**
 * `planSharedReconcileBeforePull` is `nomad diff` / `pull --dry-run`'s
 * pre-rebase counterpart to `reconcileSharedLinksBeforePull`: it runs the real
 * mirror in dry-run mode (not a separate predictor) so the two surfaces cannot
 * silently disagree about what a real pull would capture.
 */
describe('planSharedReconcileBeforePull', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-plan-reconcile-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    vi.resetModules();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('collects the real dry-run mirror events into plans.captures, writing nothing', async () => {
    const repoClaudeMd = join(sharedDir, 'CLAUDE.md');
    const localClaudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(repoClaudeMd, '# repo copy\n');
    writeFileSync(localClaudeMd, '# host edit\n');

    stubPlatform('win32');
    const { planSharedReconcileBeforePull } = await import('./commands.pull.win32.ts');
    const plans = planSharedReconcileBeforePull(repoUnderHome, '20260810-050000');

    expect(plans.captures).toEqual([
      { kind: 'mirror', name: 'CLAUDE.md', localPath: localClaudeMd, repoPath: repoClaudeMd },
    ]);
    // Read-only: the repo-side file must stay byte-unchanged.
    expect(readFileSync(repoClaudeMd, 'utf8')).toBe('# repo copy\n');
  });

  it('returns empty plans on a non-win32 platform', async () => {
    stubPlatform('linux');
    const { planSharedReconcileBeforePull } = await import('./commands.pull.win32.ts');
    const plans = planSharedReconcileBeforePull(repoUnderHome, '20260810-050001');
    // namesDerived stays false: both halves return before deriving anything off
    // win32, so the preview's own derivation is the only one that ever runs
    // there and must keep reporting a rejected entry.
    expect(plans).toEqual({ captures: [], deletions: [], namesDerived: false });
  });

  it('warns exactly once for one invalid sharedDirs entry across both read-only halves', async () => {
    // The dry-run mirror and the deletion planner each derived their own name
    // list, so `pull --dry-run` reported one rejected entry twice and a user
    // counting lines concluded two entries were rejected. The baseline is
    // required for the deletion half to enumerate anything at all; see the
    // matching note on the wet reconcile's own count assertion.
    plantSharedBaseline(testHome);
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: {}, sharedDirs: ['../escape'] }) + '\n',
    );
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { planSharedReconcileBeforePull } = await import('./commands.pull.win32.ts');
    const plans = planSharedReconcileBeforePull(repoUnderHome, '20260810-050002');

    const rejectionCalls = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sharedDirs entry'),
    );
    expect(rejectionCalls).toHaveLength(1);
    expect(plans.namesDerived).toBe(true);
    expect(plans.derivedSharedDirs).toEqual(['../escape']);
  });
});

/**
 * The two helpers that decide whether a pre-rebase derivation's rejection WARNs
 * still describe the post-rebase map. Driven directly here because the whole
 * point of them is what they do when the two maps DISAGREE, and reaching that
 * through `runPullCore` needs a rebase that rewrites `path-map.json` mid-run
 * (`commands.pull.test.ts` has those end-to-end cases).
 */
describe('namesAlreadyReported and plansAgainst', () => {
  it('never silences a derivation the pre-rebase step never made', async () => {
    const { namesAlreadyReported } = await import('./commands.pull.win32.ts');
    // Posix, force-remote, and an unreadable map all arrive here.
    expect(
      namesAlreadyReported(false, undefined, { projects: {}, sharedDirs: ['../escape'] }),
    ).toBe(false);
  });

  it('silences the later derivation only while sharedDirs has not moved', async () => {
    const { namesAlreadyReported } = await import('./commands.pull.win32.ts');
    expect(namesAlreadyReported(true, ['a'], { projects: {}, sharedDirs: ['a'] })).toBe(true);
    expect(namesAlreadyReported(true, undefined, { projects: {} })).toBe(true);
    // Delivered by the rebase: the pre-rebase WARNs said nothing about this.
    expect(namesAlreadyReported(true, undefined, { projects: {}, sharedDirs: ['../escape'] })).toBe(
      false,
    );
    // Replaced by the rebase: the pre-rebase WARNs named the wrong entry.
    expect(
      namesAlreadyReported(true, ['../before'], { projects: {}, sharedDirs: ['../after'] }),
    ).toBe(false);
  });

  it('passes a missing plans object straight through', async () => {
    // The wet path computes no plans. Handling that here rather than at the call
    // site is what keeps `runPullCore` free of another branch.
    const { plansAgainst } = await import('./commands.pull.win32.ts');
    expect(plansAgainst(undefined, { projects: {} })).toBeUndefined();
  });

  it('re-evaluates namesDerived against the post-rebase map, leaving the plans intact', async () => {
    const { plansAgainst } = await import('./commands.pull.win32.ts');
    const plans = {
      captures: [],
      deletions: [],
      namesDerived: true,
      derivedSharedDirs: ['../before'],
    };

    expect(plansAgainst(plans, { projects: {}, sharedDirs: ['../before'] })?.namesDerived).toBe(
      true,
    );
    const stale = plansAgainst(plans, { projects: {}, sharedDirs: ['../after'] });
    expect(stale?.namesDerived).toBe(false);
    // Only the flag moves: the plans themselves are deliberately pre-rebase.
    expect(stale?.captures).toBe(plans.captures);
    expect(stale?.deletions).toBe(plans.deletions);
  });
});

/**
 * The denylist backstop that runs after both pre-pull passes, against a real
 * `git status` snapshot rather than the untracked-only diff the mirror already
 * takes. That distinction is the whole point of this block: `git ls-files
 * --others` only ever lists untracked paths, so content appended to an
 * ALREADY-TRACKED file under `shared/` never appears in either the before or
 * the after snapshot and the diff is empty for it.
 *
 * The denylisted content is written straight into the repo working tree in
 * every fixture, not through the mirror. The mirror's own copy-time filter
 * already refuses it; this gate exists for the paths that reach `shared/`
 * another way, which is precisely a hand-edit under the repo.
 */
describe.skipIf(!hasGit)('reconcileSharedLinksBeforePull denylist backstop', () => {
  const realPlatform = process.platform;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repo: string;
  let errSpy: MockInstance<(...args: unknown[]) => void>;
  const TS = '20260810-020000';

  /** The denylisted repo-relative path every fixture below targets. */
  const DENIED = 'shared/commands/sessions/notes.md';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-backstop-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    repo = join(testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared', 'commands'), { recursive: true });
    mkdirSync(join(testHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# committed deploy\n');
    gitInit(repo);
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'base'], repo);
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /** Every captured stderr line joined, for substring assertions. */
  function warnings(): string {
    return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  it('removes an untracked denylisted path and names both the path and the segment', async () => {
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, DENIED), 'token=abc\n');

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repo, TS);

    expect(existsSync(join(repo, DENIED))).toBe(false);
    expect(warnings()).toContain(DENIED);
    expect(warnings()).toContain('sessions');
  });

  it('reports a TRACKED denylisted path and changes neither the file nor the index', async () => {
    // The case the mirror's own untracked-file accounting cannot see at all:
    // the path is already in git history, so a local edit to it never enters
    // either snapshot of the before/after diff. It is also the case where
    // acting means reconstructing an index state from a status prefix, so the
    // gate reports it and names the command instead.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, DENIED), '# committed notes\n');
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'add notes'], repo);
    writeFileSync(join(repo, DENIED), '# committed notes\ntoken=abc\n');
    const stagedBefore = gitOut(['diff', '--cached', '--name-status'], repo);

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repo, TS);

    expect(existsSync(join(repo, DENIED))).toBe(true);
    expect(readFileSync(join(repo, DENIED), 'utf8')).toBe('# committed notes\ntoken=abc\n');
    expect(gitOut(['diff', '--cached', '--name-status'], repo)).toBe(stagedBefore);
    expect(warnings()).toContain(DENIED);
    expect(warnings()).toContain('sessions');
    expect(warnings()).toContain(`git checkout HEAD -- ${DENIED}`);
    expect(warnings()).toContain('Nothing was changed');
  });

  it('leaves an ordinary shared edit alone and emits no WARN', async () => {
    writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# edited deploy\n');

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repo, TS);

    expect(readFileSync(join(repo, 'shared', 'commands', 'deploy.md'), 'utf8')).toBe(
      '# edited deploy\n',
    );
    expect(warnings()).toBe('');
  });

  it('reverts nothing and warns nothing when the repo is not a git checkout', async () => {
    // Acting on an unanswerable snapshot is how a gate deletes the wrong path,
    // so an unavailable probe degrades to a silent skip, not to a revert.
    const plain = join(testHome, 'plain');
    mkdirSync(join(plain, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(plain, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    writeFileSync(join(plain, DENIED), 'token=abc\n');

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    expect(() => reconcileSharedLinksBeforePull(plain, TS)).not.toThrow();

    expect(existsSync(join(plain, DENIED))).toBe(true);
    expect(warnings()).toBe('');
  });
});
