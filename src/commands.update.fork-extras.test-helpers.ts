import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import type * as topologyModule from './update.topology.ts';

/**
 * Run a real git command in `cwd`. Test-only helper for the fork-topology
 * regression suite; surfaces stderr on failure so a misbuilt fixture is loud.
 *
 * @param cwd - Working directory to run git in.
 * @param args - Argv passed to git (no shell).
 * @returns The command's stdout as a string.
 */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Read `git status --porcelain=v1` in `cwd` as a trimmed string. Used to
 * assert observable index/working-tree state after `cmdUpdate` runs.
 *
 * @param cwd - Working directory to read status in.
 * @returns Trimmed porcelain status output.
 */
export function status(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1']).trim();
}

/** Disk layout returned by `setupForkRepo`: the sandbox `root` and the local
 * mirror clone `local` the fork update operates on. */
export type ForkRepo = { root: string; local: string };

/**
 * Build a real fork topology on disk: a bare upstream, a seed checkout that
 * pushes the base commit, and a local mirror clone with an `upstream` remote.
 * `-b main` on the bare init makes the local clone check out `main` (not an
 * unborn default branch that fails `cmdUpdate`'s branch check). Sets
 * `process.env.HOME`/`NOMAD_HOST`/`NOMAD_REPO` for the test.
 *
 * @returns The sandbox `root` and the local mirror `local` paths.
 */
export function setupForkRepo(): ForkRepo {
  const root = mkdtempSync(join(tmpdir(), 'nomad-112-'));
  process.env.HOME = root;
  process.env.NOMAD_HOST = 'test-host';

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

  const local = join(root, 'claude-nomad');
  git(root, ['clone', '-q', upstreamBare, local]);
  git(local, ['config', 'user.email', 't@e.com']);
  git(local, ['config', 'user.name', 'T']);
  git(local, ['remote', 'add', 'upstream', upstreamBare]);
  process.env.NOMAD_REPO = local;
  return { root, local };
}

/**
 * Advance the seed checkout and push it to the bare upstream so the local
 * mirror's `git fetch upstream` sees the new commit. `mutate` writes the
 * upstream-side files before the commit.
 *
 * @param root - Sandbox root containing the `seed` checkout.
 * @param message - Commit message for the upstream-side commit.
 * @param mutate - Callback that writes the upstream-side file changes.
 */
export function advanceUpstream(root: string, message: string, mutate: () => void): void {
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
 * not touch the registry).
 *
 * @param onNpm - Optional callback fired on each stubbed `npm` invocation (e.g. to simulate a lockfile regeneration).
 * @returns An object with `npmCalls`, the recorded npm argv list.
 */
export function installStubs(onNpm?: () => void): { npmCalls: string[] } {
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
