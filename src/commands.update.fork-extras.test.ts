import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as topologyModule from './update.topology.ts';

/**
 * Run a real git command in `cwd`. Test-only helper for the fork-topology
 * regression suite; surfaces stderr on failure so a misbuilt fixture is loud.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Read `git status --porcelain=v1` in `cwd` as a trimmed string. Used to
 * assert observable index/working-tree state after `cmdUpdate` runs.
 */
function status(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1']).trim();
}

// Regression for issue #112. A fork host whose untracked `shared/extras/`
// overlaps a path upstream also introduces makes `git merge upstream/main`
// ABORT pre-merge ("untracked working tree files would be overwritten"). No
// UU state is created, so `tryAutoResolveMergeConflict`'s `--diff-filter=U`
// probe is empty and the generic "git merge upstream/main failed" re-throws.
// The fix pre-commits the whitelisted extras before the merge so the overlap
// becomes a tracked-file merge: identical content merges cleanly (the real
// world sync case, leaving the lone `UU package-lock.json` the existing
// auto-resolve handles), divergent content surfaces a real conflict instead
// of an opaque abort. Uses a REAL fork topology on disk; only `loadTopology`
// (URL-slug cosmetic), `cmdDoctor`, and `npm` are stubbed.
describe('issue #112: fork merge with overlapping untracked extras', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let root: string;
  let local: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    root = mkdtempSync(join(tmpdir(), 'nomad-112-'));
    process.env.HOME = root;
    process.env.NOMAD_HOST = 'test-host';

    // Bare upstream + seed checkout that pushes the base commit. `-b main`
    // makes the bare HEAD point at `main` so the local clone checks out
    // `main` (not an unborn default branch that fails `cmdUpdate`'s branch
    // check). Matches the production layout the fork update expects.
    const upstreamBare = join(root, 'up.git');
    git(root, ['init', '-q', '-b', 'main', '--bare', upstreamBare]);
    const seed = join(root, 'seed');
    git(root, ['init', '-q', seed]);
    git(seed, ['config', 'user.email', 't@e.com']);
    git(seed, ['config', 'user.name', 'T']);
    mkdirSync(join(seed, 'shared'), { recursive: true });
    writeFileSync(join(seed, 'shared', 'CLAUDE.md'), '# c\n');
    writeFileSync(join(seed, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    writeFileSync(join(seed, 'package-lock.json'), '{"v":1}\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'base']);
    git(seed, ['branch', '-M', 'main']);
    git(seed, ['remote', 'add', 'up', upstreamBare]);
    git(seed, ['push', '-q', 'up', 'main']);

    // Local mirror clones the base commit (no extras yet).
    local = join(root, 'claude-nomad');
    git(root, ['clone', '-q', upstreamBare, local]);
    git(local, ['config', 'user.email', 't@e.com']);
    git(local, ['config', 'user.name', 'T']);
    git(local, ['remote', 'add', 'upstream', upstreamBare]);
    process.env.NOMAD_REPO = local;

    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./update.topology.ts');
    vi.doUnmock('./commands.doctor.ts');
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Advance the seed checkout and push it to the bare upstream so the local
   * mirror's `git fetch upstream` sees the new commit. `mutate` writes the
   * upstream-side files before the commit.
   */
  function advanceUpstream(message: string, mutate: () => void): void {
    mutate();
    const seed = join(root, 'seed');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', message]);
    git(seed, ['push', '-q', 'up', 'main']);
  }

  /**
   * Install the standard stubs: `loadTopology` -> 'fork' (bypasses the
   * canonical-URL slug match so a local bare upstream counts as fork), a
   * no-op `cmdDoctor`, and an `execFileSync` that passes git through to the
   * real binary while no-opping `npm` (so the auto-resolver's reinstall does
   * not touch the registry). Returns the recorded npm argv list.
   */
  function installStubs(onNpm?: () => void): { npmCalls: string[] } {
    const npmCalls: string[] = [];
    vi.doMock('./update.topology.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof topologyModule>();
      return { ...actual, loadTopology: vi.fn(() => 'fork') };
    });
    vi.doMock('./commands.doctor.ts', () => ({ cmdDoctor: vi.fn() }));
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (bin: string, args: readonly string[], opts?: Parameters<typeof execFileSync>[2]) => {
            if (bin === 'npm') {
              npmCalls.push(args.join(' '));
              // Simulate a lockfile-regenerating install when the test asks.
              if (onNpm) onNpm();
              return Buffer.from('');
            }
            return actual.execFileSync(bin, args, opts);
          },
        ),
      };
    });
    return { npmCalls };
  }

  it('identical extras overlap: pre-commit lets the lone-lockfile auto-resolve fire', async () => {
    // Upstream adds the extras path AND bumps the lockfile (release landed).
    advanceUpstream('release + extras', () => {
      const seed = join(root, 'seed');
      mkdirSync(join(seed, 'shared', 'extras', 'myproj', '.planning'), { recursive: true });
      writeFileSync(join(seed, 'shared', 'extras', 'myproj', '.planning', 'x.md'), '# SHARED\n');
      writeFileSync(join(seed, 'package-lock.json'), '{"v":2}\n');
    });

    // Local: same extras content (synced from the same origin) sitting
    // untracked, plus a locally-committed diverged lockfile.
    mkdirSync(join(local, 'shared', 'extras', 'myproj', '.planning'), { recursive: true });
    writeFileSync(join(local, 'shared', 'extras', 'myproj', '.planning', 'x.md'), '# SHARED\n');
    writeFileSync(join(local, 'package-lock.json'), '{"v":99}\n');
    git(local, ['add', 'package-lock.json']);
    git(local, ['commit', '-q', '-m', 'local lockfile']);
    writeFileSync(
      join(local, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { myproj: ['.planning'] } }) + '\n',
    );

    const { npmCalls } = installStubs();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');

    // Must NOT throw the generic merge-failed; reaches auto-resolve.
    expect(() => cmdUpdate({ force: true, prompt: () => 'n' })).not.toThrow();
    // The auto-resolver reinstalled exactly once.
    expect(npmCalls).toContain('install');
    // The merge committed: no unmerged paths remain. (path-map.json is left
    // untracked test scaffolding, so we assert on the conflict set, not a
    // fully-clean tree.)
    expect(git(local, ['diff', '--name-only', '--diff-filter=U']).trim()).toBe('');
    expect(status(local)).not.toContain('UU ');
    // HEAD is a merge commit (the merge landed rather than aborting).
    expect(git(local, ['log', '-1', '--pretty=%P']).trim().split(' ')).toHaveLength(2);
    // The merged extras file is present and tracked.
    expect(git(local, ['ls-files', 'shared/extras/myproj/.planning/x.md']).trim()).toBe(
      'shared/extras/myproj/.planning/x.md',
    );
  });

  it('divergent extras overlap: surfaces a real merge conflict, not an opaque abort', async () => {
    advanceUpstream('add extras', () => {
      const seed = join(root, 'seed');
      mkdirSync(join(seed, 'shared', 'extras', 'myproj', '.planning'), { recursive: true });
      writeFileSync(join(seed, 'shared', 'extras', 'myproj', '.planning', 'x.md'), '# UPSTREAM\n');
    });

    // Local: SAME path, DIFFERENT content, untracked.
    mkdirSync(join(local, 'shared', 'extras', 'myproj', '.planning'), { recursive: true });
    writeFileSync(join(local, 'shared', 'extras', 'myproj', '.planning', 'x.md'), '# LOCAL\n');
    writeFileSync(
      join(local, 'path-map.json'),
      JSON.stringify({ projects: {}, extras: { myproj: ['.planning'] } }) + '\n',
    );

    installStubs();
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');
    const { NomadFatal } = await import('./utils.ts');

    let caught: unknown;
    try {
      cmdUpdate({ force: true, prompt: () => 'n' });
    } catch (err) {
      caught = err;
    }
    // It still fails (genuine divergent conflict), but as a real merge
    // conflict the user can resolve, with a UU recorded, NOT the pre-merge
    // untracked-overwrite abort that left no merge state.
    expect(caught).toBeInstanceOf(NomadFatal);
    const u = git(local, ['diff', '--name-only', '--diff-filter=U']).trim();
    expect(u).toContain('shared/extras/myproj/.planning/x.md');
  });

  it('post-merge lockfile regeneration is committed so the tree is clean', async () => {
    // Upstream bumps the lockfile (a clean fast-forward, no extras overlap),
    // so the post-merge reinstall fires. The simulated `npm install`
    // regenerates package-lock.json to a third value, leaving drift the
    // trailing doctor would otherwise flag. commitRegeneratedLockfile must
    // stage + commit just that file.
    advanceUpstream('bump lockfile', () => {
      const seed = join(root, 'seed');
      writeFileSync(join(seed, 'package-lock.json'), '{"v":2}\n');
    });

    // No path-map / extras here: isolates the secondary lockfile-commit path.
    const { npmCalls } = installStubs(() => {
      // Simulate npm regenerating the lockfile to a new content.
      writeFileSync(join(local, 'package-lock.json'), '{"v":3,"regenerated":true}\n');
    });
    vi.resetModules();
    const { cmdUpdate } = await import('./commands.update.ts');

    expect(() => cmdUpdate({ prompt: () => 'n' })).not.toThrow();
    // The reinstall ran (lockfile changed in the merge).
    expect(npmCalls).toContain('install');
    // The regenerated lockfile is committed: no working-tree drift remains.
    expect(git(local, ['diff', '--name-only', '--', 'package-lock.json']).trim()).toBe('');
    // The committed content is the regenerated one.
    expect(git(local, ['show', 'HEAD:package-lock.json'])).toContain('regenerated');
    // HEAD is the dedicated lockfile-commit, scoped to package-lock.json only.
    expect(git(local, ['show', '--name-only', '--pretty=format:', 'HEAD']).trim()).toBe(
      'package-lock.json',
    );
  });
});
