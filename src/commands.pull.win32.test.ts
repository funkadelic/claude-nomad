import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubPlatform } from './test-helpers.platform.ts';

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
    vi.doUnmock('./links.ts');
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
    vi.doMock('./links.ts', () => ({ stageLocalSharedEdits: mirror }));
    vi.doMock('./links.deletions.ts', () => ({ applySharedLinkDeletions: deletions }));
    return { mirror, deletions };
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
    expect(mirror).toHaveBeenCalledWith({ projects: {}, sharedDirs: ['extra'] }, TS);
  });

  it('does nothing at all on a posix platform', async () => {
    stubPlatform('linux');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    const created = reconcileSharedLinksBeforePull(repoUnderHome, TS);
    expect(mirror).not.toHaveBeenCalled();
    expect(deletions).not.toHaveBeenCalled();
    // Nothing was mirrored, so nothing is this run's to account for, and the
    // collision runbook downstream stays entirely out of the posix pull.
    expect(created).toEqual([]);
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
    expect(reconcileSharedLinksBeforePull(repoUnderHome, TS)).toEqual([]);
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
    expect(mirror).toHaveBeenCalledWith({ projects: {} }, TS);
    expect(deletions).toHaveBeenCalledWith({ projects: {} }, TS);
  });

  it('passes null to both passes on a malformed path-map.json', async () => {
    writeFileSync(join(repoUnderHome, 'path-map.json'), '{ not json\n');
    stubPlatform('win32');
    const order: string[] = [];
    const { mirror, deletions } = mockPasses(order);
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repoUnderHome, TS);
    // Degrades rather than throwing; the post-rebase read still dies loudly.
    expect(mirror).toHaveBeenCalledWith(null, TS);
    expect(deletions).toHaveBeenCalledWith(null, TS);
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
