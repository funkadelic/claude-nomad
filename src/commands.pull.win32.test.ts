import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { SHARED_LINKS } from './config.ts';
import { renderTree } from './output-tree.ts';
import { g, gitInit } from './test-support/git.ts';
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
    vi.doMock('./links.mirror.ts', () => ({ stageLocalSharedEdits: mirror }));
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
    expect(plans).toEqual({ captures: [], deletions: [] });
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

  it('restores a TRACKED denylisted path to its committed content instead of deleting it', async () => {
    // The case the mirror's own untracked-file accounting cannot see at all:
    // the path is already in git history, so a local edit to it never enters
    // either snapshot of the before/after diff.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, DENIED), '# committed notes\n');
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'add notes'], repo);
    writeFileSync(join(repo, DENIED), '# committed notes\ntoken=abc\n');

    stubPlatform('win32');
    const { reconcileSharedLinksBeforePull } = await import('./commands.pull.win32.ts');
    reconcileSharedLinksBeforePull(repo, TS);

    expect(existsSync(join(repo, DENIED))).toBe(true);
    expect(readFileSync(join(repo, DENIED), 'utf8')).toBe('# committed notes\n');
    expect(warnings()).toContain(DENIED);
    expect(warnings()).toContain('sessions');
    expect(warnings()).toContain(`backup/${TS}/repo/`);
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
