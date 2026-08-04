import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubPlatform } from './test-helpers.platform.ts';
import { buildSyncedSharedWorld } from './test-support/git.ts';

/**
 * End-to-end deletion parity for the win32 pull, against a real git repo.
 *
 * These run IN PROCESS: the platform is stubbed and `commands.pull.ts` is
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

  /** Run one real wet pull against the fixture, on the currently stubbed platform. */
  async function pull(): Promise<void> {
    const { runPullCore } = await import('./commands.pull.ts');
    runPullCore();
  }

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

  it('plans and removes nothing on a posix platform, even with a real baseline', async () => {
    stubPlatform('win32');
    await pull();
    rmSync(join(world.claudeDir, 'commands', 'doomed.md'), { force: true });

    stubPlatform('linux');
    const { applySharedLinkDeletions, planSharedLinkDeletions } =
      await import('./links.deletions.ts');
    expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
    applySharedLinkDeletions({ projects: {} }, '20260803-000000');
    expect(existsSync(join(world.sharedDir, 'commands', 'doomed.md'))).toBe(true);
  });
});
