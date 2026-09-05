import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubPlatform } from '../../test-helpers.platform.ts';
import { buildSyncedSharedWorld, pushUpstreamChange } from '../../test-support/git.ts';

/**
 * End-to-end cover for the win32 mirror collision, against a real git repo: a
 * file the user created that the incoming update also adds.
 *
 * These run IN PROCESS: the platform is stubbed and `commands/pull/pull.ts` is
 * imported dynamically afterwards. The subprocess harness cannot be used here,
 * because it spawns a child whose platform is the real host OS, so a stubbed
 * platform in the parent would be invisible and every assertion would silently
 * exercise the posix path instead.
 */
describe('runPullCore: win32 mirror collision', () => {
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
    tmp = mkdtempSync(join(tmpdir(), 'nomad-win32-collision-'));
    world = buildSyncedSharedWorld(tmp);
    process.env.HOME = world.home;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO, so an ambient value would point these
    // assertions at a repo the code under test never touched.
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

  /** Current HEAD of the fixture sync repo. */
  function head(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: world.repo,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  }

  /**
   * Run one real wet pull against the fixture and return whatever it threw.
   *
   * @returns The thrown value, or `undefined` when the pull returned normally.
   */
  async function pull(): Promise<unknown> {
    const { runPullCore } = await import('./pull.ts');
    try {
      runPullCore();
      return undefined;
    } catch (err) {
      return err;
    }
  }

  /** Stage the collision: a file the user created that upstream also adds. */
  function stageCollision(): void {
    writeFileSync(join(world.claudeDir, 'commands', 'mine.md'), '# my version\n');
    pushUpstreamChange(
      world.origin,
      tmp,
      'shared/commands/mine.md',
      '# from another host\n',
      'upstream adds mine',
    );
  }

  it('explains the collision in nomad terms instead of forwarding git advice', async () => {
    stubPlatform('win32');
    stageCollision();

    const err = await pull();

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    const message = (err as InstanceType<typeof NomadFatal>).message;
    expect(message).toContain('nomad pull could not fetch');
    // The file the user has to act on is the local original. Git's own advice
    // names the repo copy, and acting on that alone reproduces this failure on
    // the next run, because the mirror re-copies the local file before fetching.
    expect(message).toContain('~/.claude/commands/mine.md');
    expect(message).not.toContain('shared/commands/mine.md');
  });

  it('removes its own copy so the next pull is not blocked by this one', async () => {
    stubPlatform('win32');
    stageCollision();

    await pull();

    expect(existsSync(join(world.sharedDir, 'commands', 'mine.md'))).toBe(false);
  });

  it('leaves the host untouched and the update unapplied', async () => {
    stubPlatform('win32');
    stageCollision();
    const before = head();

    await pull();

    // The user's file is still exactly as they left it, not the incoming one.
    expect(readFileSync(join(world.claudeDir, 'commands', 'mine.md'), 'utf8')).toBe(
      '# my version\n',
    );
    expect(readFileSync(join(world.claudeDir, 'commands', 'keep.md'), 'utf8')).toBe('# keep\n');
    // The update did not land...
    expect(head()).toBe(before);
    // ...and no side effect of a successful pull ran: settings.json is written
    // by the first step after the rebase, so its absence is the whole apply
    // half staying unreached.
    expect(existsSync(join(world.claudeDir, 'settings.json'))).toBe(false);
  });

  it('never removes a file that was already untracked before the run', async () => {
    stubPlatform('win32');
    stageCollision();
    // Put by hand into the repo, so it is in the before snapshot and is not
    // this run's to account for.
    writeFileSync(join(world.sharedDir, 'commands', 'preexisting.md'), '# mine, by hand\n');

    await pull();

    expect(readFileSync(join(world.sharedDir, 'commands', 'preexisting.md'), 'utf8')).toBe(
      '# mine, by hand\n',
    );
    // The collision in the same run still cleaned up, so the survival above is
    // the before snapshot working rather than the removal doing nothing.
    expect(existsSync(join(world.sharedDir, 'commands', 'mine.md'))).toBe(false);
  });

  it('reports an ordinary pull failure unchanged when the mirror created nothing', async () => {
    stubPlatform('win32');
    // The host is genuinely in sync, so the mirror overwrites the repo copies
    // with identical content and adds no untracked path at all.
    execFileSync('git', ['remote', 'set-url', 'origin', join(tmp, 'gone.git')], {
      cwd: world.repo,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const err = await pull();

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    // Every non-collision failure keeps today's wording, forwarded git stderr
    // included. This is the regression that matters most.
    expect((err as InstanceType<typeof NomadFatal>).message).toBe('git pull --rebase failed');
  });
});
