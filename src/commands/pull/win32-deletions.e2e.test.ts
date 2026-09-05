import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PullCoreResult } from './pull.ts';

import { EXIT } from '../../exit-codes.ts';
import { stubPlatform } from '../../test-helpers.platform.ts';
import {
  buildSyncedSharedWorld,
  pushUpstreamChange,
  wedgeExistingRepo,
} from '../../test-support/git.ts';

/**
 * End-to-end deletion parity for the win32 pull, against a real git repo.
 *
 * These run IN PROCESS: the platform is stubbed and `commands/pull/pull.ts` is
 * imported dynamically afterwards. The subprocess harness cannot be used here,
 * because it spawns a child whose platform is the real host OS, so a stubbed
 * platform in the parent would be invisible and every assertion would silently
 * exercise the posix path instead.
 */
describe('runPullCore: win32 shared-config deletion parity', () => {
  const realPlatform = process.platform;
  let originalEnv: Record<string, string | undefined>;
  let tmp: string;
  let world: ReturnType<typeof buildSyncedSharedWorld>;

  /** Env keys stamped per test and restored afterwards. */
  const ENV_KEYS = [
    'HOME',
    'NOMAD_HOST',
    'NOMAD_REPO',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
  ] as const;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.exitCode = 0;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-win32-deletions-'));
    world = buildSyncedSharedWorld(tmp);
    process.env.HOME = world.home;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO, and CLAUDE.md tells developers to export it
    // for an alternate checkout, so an ambient value would point these
    // assertions at a repo the code under test never touched. Stamp it at the
    // fixture clone rather than merely deleting it.
    process.env.NOMAD_REPO = world.repo;
    // Neutralize the developer's global/system gitconfig for the in-process git
    // calls nomad itself makes, so a host-level commit.gpgsign or core.hooksPath
    // cannot break or hang the pull.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Restore the real platform BEFORE mock restoration and sandbox removal, so
    // nothing downstream runs under a stale stub.
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    process.exitCode = 0;
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Absolute path of this host's baseline file inside the sandbox. */
  function baselineFile(): string {
    return join(world.home, '.cache', 'claude-nomad', 'shared-baseline-test-host.json');
  }

  /** True when `relPath` is still present in the repo's committed HEAD tree. */
  function inHeadTree(repo: string, relPath: string): boolean {
    try {
      execFileSync('git', ['cat-file', '-e', `HEAD:${relPath}`], {
        cwd: repo,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run one real wet pull against the fixture, on the currently stubbed
   * platform, returning `runPullCore`'s result. Existing `await pull()`
   * callers that ignore the return are unaffected.
   */
  async function pull(): Promise<PullCoreResult> {
    const { runPullCore } = await import('./pull.ts');
    return runPullCore();
  }

  it('names the removed repo path in the wet Symlinks section', async () => {
    stubPlatform('win32');
    // First pull: records the baseline from the genuinely synced state.
    await pull();
    // The user deletes one file from inside a shared directory.
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });
    const result = await pull();

    // Matched on the shipped result shape so a future shape change fails
    // loudly instead of this assertion silently checking nothing.
    if (result.tag !== 'wet') throw new Error('expected a wet pull result');
    const symlinks = result.sections.find((s) => s.header === 'Symlinks');
    const rendered = symlinks?.items.join('\n') ?? '';
    expect(rendered).toContain(
      `removed  ${join(world.sharedDir, 'commands', 'doomed.md')} (gone from`,
    );
  });

  it('propagates a local deletion into the repo worktree and does not resurrect it', async () => {
    stubPlatform('win32');
    // First pull: records the baseline from the genuinely synced state.
    await pull();
    // The user deletes one file from inside a shared directory.
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });
    await pull();

    expect(existsSync(join(world.sharedDir, 'commands', 'doomed.md'))).toBe(false);
    // Uncommitted: the blob is still at HEAD. Staging and committing belong to
    // the push pipeline, including its secret-scan gate.
    expect(inHeadTree(world.repo, 'shared/commands/doomed.md')).toBe(true);
    // The repo-to-local overlay runs later in this same pull; the whole point of
    // the deletion pass is that it has nothing left to put back.
    expect(existsSync(join(world.claudeDir, 'commands', 'doomed.md'))).toBe(false);
    // The untouched sibling survives on both sides.
    expect(readFileSync(join(world.sharedDir, 'commands', 'keep.md'), 'utf8')).toBe('# keep\n');
    expect(readFileSync(join(world.claudeDir, 'commands', 'keep.md'), 'utf8')).toBe('# keep\n');
  });

  it('leaves a repo file this host has never materialized alone', async () => {
    stubPlatform('win32');
    await pull();
    // Planted after the baseline was written, so this host has never had it
    // locally and it is absent from the record that authorizes deletions.
    writeFileSync(join(world.sharedDir, 'commands', 'never-had.md'), '# from another host\n');
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });
    await pull();

    expect(readFileSync(join(world.sharedDir, 'commands', 'never-had.md'), 'utf8')).toBe(
      '# from another host\n',
    );
    // The genuine deletion in the same run still propagated, so the survival
    // above is the baseline gate working rather than the pass doing nothing.
    expect(existsSync(join(world.sharedDir, 'commands', 'doomed.md'))).toBe(false);
  });

  it('backs the removed repo file up before removing it', async () => {
    stubPlatform('win32');
    await pull();
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });
    await pull();

    // A wrong removal has to be recoverable from the same timestamped cache the
    // rest of the pull writes into. The ts is minted per run, so enumerate the
    // run directories rather than reconstructing it.
    const backupRoot = join(world.home, '.cache', 'claude-nomad', 'backup');
    const snapshots = readdirSync(backupRoot)
      .map((ts) => join(backupRoot, ts, 'repo', 'shared', 'commands', 'doomed.md'))
      .filter((p) => existsSync(p));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(readFileSync(snapshots[0], 'utf8')).toBe('# doomed\n');
  });

  it('writes no baseline at all on a dry run', async () => {
    stubPlatform('win32');
    const { runPullCore } = await import('./pull.ts');
    runPullCore({ dryRun: true });
    expect(existsSync(baselineFile())).toBe(false);
  });

  it('leaves the baseline and the pending deletion untouched when the pull aborts', async () => {
    stubPlatform('win32');
    await pull();
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });
    const before = readFileSync(baselineFile(), 'utf8');
    // A repo left unmerged by an earlier conflicted pop: the preflight conflict
    // guard fires before anything in this run touches the host or the repo.
    wedgeExistingRepo(world.repo);

    const { NomadFatal } = await import('../../utils.ts');
    const { runPullCore } = await import('./pull.ts');
    let fatal: unknown;
    try {
      runPullCore();
    } catch (err) {
      fatal = err;
    }
    // Matched on the shipped guard's type and exit code so an unrelated failure
    // cannot masquerade as this assertion passing.
    expect(fatal).toBeInstanceOf(NomadFatal);
    expect((fatal as InstanceType<typeof NomadFatal>).code).toBe(EXIT.CONFLICT);

    // An abort must neither advance the record...
    expect(readFileSync(baselineFile(), 'utf8')).toBe(before);
    // ...nor lose the pending intent: the next run replays the same
    // already-authorized removal rather than inventing a different one.
    const { planSharedLinkDeletions } = await import('../../links.deletions.ts');
    const plan = planSharedLinkDeletions({ projects: {} });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.repoPath).toBe(join(world.sharedDir, 'commands', 'doomed.md'));
  });

  it('leaves a delete-versus-upstream-modify collision to git', async () => {
    stubPlatform('win32');
    await pull();
    const before = readFileSync(baselineFile(), 'utf8');
    // Upstream edits the very file this host deleted. There is no win32-only
    // pre-check for this and no nomad-worded delete conflict: the stash pop is
    // the same mechanism a posix host running the same git command would hit.
    pushUpstreamChange(
      world.origin,
      tmp,
      'shared/commands/doomed.md',
      '# upstream edit\n',
      'upstream modifies doomed',
    );
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });

    const { NomadFatal } = await import('../../utils.ts');
    const { runPullCore } = await import('./pull.ts');
    let outcome: 'aborted' | 'resolved';
    try {
      runPullCore();
      outcome = 'resolved';
    } catch (err) {
      expect(err).toBeInstanceOf(NomadFatal);
      // Matched on the shipped guard's own wording and exit code so an
      // unrelated failure cannot masquerade as this assertion passing.
      expect((err as InstanceType<typeof NomadFatal>).message).toMatch(/autostash pop/);
      expect((err as InstanceType<typeof NomadFatal>).code).toBe(EXIT.CONFLICT);
      outcome = 'aborted';
    }
    // What real git does here, asserted rather than assumed: the autostash pop
    // reports a modify/delete conflict and leaves an unmerged index, which the
    // already-shipped guard turns into an abort.
    expect(outcome).toBe('aborted');
    // Nothing reached the host config directory, and the record still describes
    // the last state this host actually had.
    expect(readFileSync(baselineFile(), 'utf8')).toBe(before);
    expect(existsSync(join(world.claudeDir, 'commands', 'doomed.md'))).toBe(false);
    expect(readFileSync(join(world.claudeDir, 'commands', 'keep.md'), 'utf8')).toBe('# keep\n');
  });

  it('plans and removes nothing on a posix platform, even with a real baseline', async () => {
    stubPlatform('win32');
    await pull();
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });

    stubPlatform('linux');
    const { applySharedLinkDeletions, planSharedLinkDeletions } =
      await import('../../links.deletions.ts');
    expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
    applySharedLinkDeletions({ projects: {} }, '20260803-000000');
    expect(existsSync(join(world.sharedDir, 'commands', 'doomed.md'))).toBe(true);
  });
});
