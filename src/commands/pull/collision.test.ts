import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as NodeFs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { g, gitInit, gitOut, makeBareOrigin, setTestIdentity } from '../../test-support/git.ts';

/**
 * The mirror-collision runbook and the pull wrapper that raises it.
 *
 * The wrapper half runs against REAL git repos (the shared harness in
 * `test-support/git.ts` drives `execFileSync`), because the two facts it keys
 * off are git's own: a `git pull --rebase` that refuses to overwrite an
 * untracked file, and a `FETCH_HEAD` that resolves the incoming path. A hand
 * built fixture could assert neither.
 */
describe('untrackedCollisionRunbookText', () => {
  it('names the ~/.claude/ original rather than the copy inside the sync repo', async () => {
    const { untrackedCollisionRunbookText } = await import('./collision.ts');
    const text = untrackedCollisionRunbookText(['shared/commands/mine.md'], true);

    expect(text).toContain('~/.claude/commands/mine.md');
    // The repo copy is the path git's own advice names, and acting on it is the
    // loop this message exists to break, so it is never printed as a target.
    expect(text).not.toContain('shared/commands/mine.md');
  });

  it('states that nothing changed and walks both recoveries from the local file', async () => {
    const { untrackedCollisionRunbookText } = await import('./collision.ts');
    const text = untrackedCollisionRunbookText(['shared/commands/mine.md'], true);

    expect(text).toContain('One of those copies has the same name');
    expect(text).toContain('Your file is still exactly as you left it.');
    expect(text).toContain("Git's advice above refers to nomad's copy inside the sync repo");
    expect(text).toContain('The file to move is the one under ~/.claude/.');
    expect(text).toContain('  1. move ~/.claude/commands/mine.md outside ~/.claude/');
    expect(text).toContain(
      '  1. rename ~/.claude/commands/mine.md to a name the repo does not use',
    );
    expect(text).toContain('(mine.local.md)');
    expect(text).toContain('  3. combine the two files, then nomad push');
  });

  it('lists every path and switches to plural wording for several collisions', async () => {
    const { untrackedCollisionRunbookText } = await import('./collision.ts');
    const text = untrackedCollisionRunbookText(
      ['shared/commands/mine.md', 'shared/rules/mine.md'],
      true,
    );

    expect(text).toContain('  ~/.claude/commands/mine.md\n  ~/.claude/rules/mine.md');
    expect(text).toContain('Each of the copies below has the same name');
    expect(text).toContain('Your files are still exactly as you left them.');
    expect(text).toContain('The files to move are the ones under ~/.claude/.');
    expect(text).toContain('  1. move each file listed above outside ~/.claude/');
    expect(text).toContain('(mine.md becomes mine.local.md)');
    expect(text).toContain('  3. combine each pair, then nomad push');
  });

  it('says the copies are still there when the cleanup did not happen', async () => {
    const { untrackedCollisionRunbookText } = await import('./collision.ts');
    const one = untrackedCollisionRunbookText(['shared/commands/mine.md'], false);
    const many = untrackedCollisionRunbookText(
      ['shared/commands/mine.md', 'shared/rules/mine.md'],
      false,
    );

    expect(one).toContain('delete it by hand if the next pull stops here again');
    expect(many).toContain('delete them by hand if the next pull stops here again');
    // The recovery steps are unchanged: they always start at the local file.
    expect(one).toContain('  1. move ~/.claude/commands/mine.md outside ~/.claude/');
  });

  it('suggests a .local name for a file with no extension', async () => {
    const { untrackedCollisionRunbookText } = await import('./collision.ts');
    expect(untrackedCollisionRunbookText(['shared/commands/mine'], true)).toContain('(mine.local)');
  });
});

describe('isContainedMirrorPath', () => {
  it('accepts a nested repo-relative path under shared/', async () => {
    const { isContainedMirrorPath } = await import('./collision.ts');
    expect(isContainedMirrorPath('shared/commands/mine.md')).toBe(true);
  });

  it('rejects anything that could unlink outside the shared tree', async () => {
    const { isContainedMirrorPath } = await import('./collision.ts');
    // Outside shared/ entirely, so not something this run's mirror wrote.
    expect(isContainedMirrorPath('hosts/other.json')).toBe(false);
    // Climbs back out of the tree the prefix appears to confine it to.
    expect(isContainedMirrorPath('shared/../.git/config')).toBe(false);
    // Absolute, and a prefix test alone would not catch it.
    expect(isContainedMirrorPath('/etc/passwd')).toBe(false);
    // A backslash separates segments on Windows, so it escapes there too.
    expect(isContainedMirrorPath('shared\\..\\..\\evil')).toBe(false);
    expect(isContainedMirrorPath('')).toBe(false);
  });
});

describe('pullWithCollisionRunbook', () => {
  let tmp: string;
  let originalEnv: Record<string, string | undefined>;

  /** Env keys stamped per test and restored afterwards. */
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME', 'USERPROFILE'] as const;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    // Neutralize the developer's global/system gitconfig for the in-process git
    // calls the code under test makes, so a host-level commit.gpgsign or
    // core.hooksPath cannot break or hang the pull.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    tmp = mkdtempSync(join(tmpdir(), 'nomad-collision-'));
    // The removal compares each repo copy against its `~/.claude/` original, so
    // the tests need a real one. Both keys are set because `home()` reads
    // USERPROFILE first on win32 and HOME everywhere else.
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // vi.restoreAllMocks does NOT clear doMock registrations, and a leaked one
    // fails an unrelated test in a different file in the same worker.
    vi.doUnmock('node:fs');
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Publish `relPaths` upstream after the clone is taken, so each one is in the
   * incoming update but not in the clone's HEAD.
   *
   * @param seed - The seed checkout that owns the origin.
   * @param relPaths - Repo-relative paths to add.
   */
  function publishUpstream(seed: string, relPaths: readonly string[]): void {
    for (const rel of relPaths) {
      mkdirSync(join(seed, rel, '..'), { recursive: true });
      writeFileSync(join(seed, rel), '# from another host\n');
    }
    g(['add', '.'], seed);
    g(['commit', '-q', '-m', 'upstream adds files'], seed);
    g(['push', '-q', 'origin', 'main'], seed);
  }

  /**
   * Build an origin plus a clone of it, then publish `upstreamAdds` after the
   * clone so those paths land in the clone's next fetch and not in its HEAD.
   *
   * @param upstreamAdds - Repo-relative paths the incoming update adds.
   * @returns The clone directory.
   */
  function buildClone(upstreamAdds: readonly string[] = []): string {
    const origin = makeBareOrigin(tmp);
    const seed = join(tmp, 'seed');
    mkdirSync(join(seed, 'shared', 'commands'), { recursive: true });
    gitInit(seed);
    writeFileSync(join(seed, 'shared', 'commands', 'keep.md'), '# keep\n');
    g(['add', '.'], seed);
    g(['commit', '-q', '-m', 'base'], seed);
    g(['remote', 'add', 'origin', origin], seed);
    g(['push', '-q', 'origin', 'main'], seed);

    const repo = join(tmp, 'repo');
    g(['clone', '-q', origin, repo], tmp);
    setTestIdentity(repo);
    if (upstreamAdds.length > 0) publishUpstream(seed, upstreamAdds);
    return repo;
  }

  /**
   * Write an untracked file into the clone, the way the win32 mirror would:
   * the local original under `~/.claude/` plus the identical copy in the repo.
   *
   * @param repo - The clone to write into.
   * @param rel - Repo-relative path, normally under `shared/`.
   * @param body - Content for both files.
   * @param localBody - Content for the `~/.claude/` original when it should
   *   NOT match the copy, or `null` to leave the original out entirely. Both
   *   stand in for a file the mirror did not write.
   */
  function plantUntracked(
    repo: string,
    rel: string,
    body: string,
    localBody: string | null = body,
  ): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), body);
    if (localBody === null) return;
    const local = join(tmp, '.claude', rel.replace(/^shared\//, ''));
    mkdirSync(join(local, '..'), { recursive: true });
    writeFileSync(local, localBody);
  }

  /**
   * Call the wrapper and return whatever it threw.
   *
   * @param repo - The clone to pull in.
   * @param mirrored - Repo-relative paths to attribute to this run's mirror.
   * @returns The thrown value, or `undefined` when the call returned normally.
   */
  async function runPull(repo: string, mirrored: readonly string[]): Promise<unknown> {
    const { pullWithCollisionRunbook } = await import('./collision.ts');
    try {
      pullWithCollisionRunbook(repo, mirrored);
      return undefined;
    } catch (err) {
      return err;
    }
  }

  it('pulls normally when nothing is in the way', async () => {
    const repo = buildClone();
    expect(await runPull(repo, [])).toBeUndefined();
  });

  it('replaces git advice with the runbook and removes the copy it made', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n');
    const headBefore = gitOut(['rev-parse', 'HEAD'], repo);

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    expect((err as InstanceType<typeof NomadFatal>).message).toContain(
      'nomad pull could not fetch',
    );
    expect((err as InstanceType<typeof NomadFatal>).message).toContain(
      '~/.claude/commands/mine.md',
    );
    // The leftover would block the next fetch on its own, which is what makes
    // the runbook one step instead of two.
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(false);
    // The update did not land: a removal that let the pull half apply would be
    // a far worse outcome than the message it replaces.
    expect(gitOut(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
  });

  it('rethrows the ordinary failure when this run created nothing', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    // The collision is real, but no created set means nothing to attribute it
    // to, so the wrapper stays out of the way entirely.
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n');

    const err = await runPull(repo, []);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    expect((err as InstanceType<typeof NomadFatal>).message).toBe('git pull --rebase failed');
    // Nothing was removed on the ordinary path.
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(true);
  });

  it('leaves a created file the incoming update does not add alone', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n');
    plantUntracked(repo, 'shared/commands/only-here.md', '# local only\n');

    const err = await runPull(repo, ['shared/commands/mine.md', 'shared/commands/only-here.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    // Only the genuinely colliding path is named...
    expect((err as InstanceType<typeof NomadFatal>).message).toContain(
      '~/.claude/commands/mine.md',
    );
    expect((err as InstanceType<typeof NomadFatal>).message).not.toContain('only-here');
    // ...and only that one is removed; the other is an unpublished edit that has
    // nothing to do with this failure.
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(false);
    expect(existsSync(join(repo, 'shared', 'commands', 'only-here.md'))).toBe(true);
  });

  it('reports an unreachable remote as the ordinary failure, not a collision', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n');
    g(['remote', 'set-url', 'origin', join(tmp, 'gone.git')], repo);

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    // A failure that never reached the remote leaves no fetched update to
    // collide with, so the created set cannot be misread as one.
    expect((err as InstanceType<typeof NomadFatal>).message).toBe('git pull --rebase failed');
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(true);
  });

  it('never removes a directory, even one the incoming update adds a file at', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    mkdirSync(join(repo, 'shared', 'commands', 'mine.md'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'mine.md', 'inner.txt'), 'inner\n');

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    expect((err as InstanceType<typeof NomadFatal>).message).toContain(
      'nomad pull could not fetch',
    );
    // Files only: a mistake in the created set must not escalate into removing
    // a tree the user owns.
    expect(statSync(join(repo, 'shared', 'commands', 'mine.md')).isDirectory()).toBe(true);
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md', 'inner.txt'))).toBe(true);
  });

  it('keeps a colliding file whose content the mirror cannot account for', async () => {
    // Something other than the mirror wrote into shared/ between the two
    // ls-files snapshots, so the path is in the created set without the mirror
    // having put it there. The snapshots cannot tell the two apart; the content
    // can, because a mirrored copy always equals its local original.
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# written by someone else\n', '# mine\n');

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(true);
    expect((err as InstanceType<typeof NomadFatal>).message).toContain(
      'which nomad could not remove',
    );
  });

  it('keeps a colliding file with no ~/.claude/ original at all', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n', null);

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    // Nothing local to have been copied from, so the mirror cannot own it.
    expect(existsSync(join(repo, 'shared', 'commands', 'mine.md'))).toBe(true);
  });

  it('never removes a colliding path from outside shared/', async () => {
    // Reachable only if the created set were ever computed without its
    // `-- shared/` pathspec, which is exactly what the removal re-asserts
    // against rather than trusting.
    const repo = buildClone(['hosts/other.json']);
    plantUntracked(repo, 'hosts/other.json', '{}\n');

    const err = await runPull(repo, ['hosts/other.json']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    expect(existsSync(join(repo, 'hosts', 'other.json'))).toBe(true);
  });

  it('warns and still raises the runbook when a removal fails', async () => {
    const repo = buildClone(['shared/commands/mine.md']);
    plantUntracked(repo, 'shared/commands/mine.md', '# my version\n');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        rmSync: () => {
          throw new Error('EBUSY: resource busy or locked');
        },
      };
    });

    const err = await runPull(repo, ['shared/commands/mine.md']);

    const { NomadFatal } = await import('../../utils.ts');
    expect(err).toBeInstanceOf(NomadFatal);
    const text = (err as InstanceType<typeof NomadFatal>).message;
    expect(text).toContain('nomad pull could not fetch');
    expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('EBUSY');
    // The leftover blocks the next fetch on its own, so claiming the cleanup
    // happened would walk the user through the steps only to land back here.
    expect(text).toContain('which nomad could not remove');
    expect(text).toContain('delete it by hand if the next pull stops here again');
    expect(text).not.toContain('has now removed for you');
  });
});
