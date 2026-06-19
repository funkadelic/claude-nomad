import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deepMerge, encodePath } from './utils.json.ts';
import { g, gitOut, plantLocalSession } from './test-support/git.ts';
import { makeWorld, runNomad } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. Used to gate the
 * whole round-trip describe so a host without git skips cleanly instead of
 * failing with an unhelpful spawn error.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('two-host round-trip (init -> push on A, pull on B)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-roundtrip-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('syncs SHARED_LINKS symlinks, settings, and a session transcript from A to B', () => {
    // Create the shared origin first; host B is cloned AFTER host A pushes so
    // B's clone is not stale and nomad pull can see shared/settings.base.json.
    const { makeHost } = makeWorld(tmp);
    const a = makeHost('host-a');

    // Seed host A's ~/.claude with the SHARED_LINK targets that init --snapshot
    // will capture, plus a settings.json precursor that will become both
    // shared/settings.base.json and hosts/host-a.json.
    mkdirSync(a.claudeHome, { recursive: true });
    writeFileSync(join(a.claudeHome, 'CLAUDE.md'), '# shared claude md\n');
    mkdirSync(join(a.claudeHome, 'commands'), { recursive: true });
    writeFileSync(join(a.claudeHome, 'commands', 'hello.md'), '# hello command\n');
    const seedSettings: Record<string, unknown> = { theme: 'dark', fontSize: 14 };
    writeFileSync(join(a.claudeHome, 'settings.json'), JSON.stringify(seedSettings) + '\n');

    // Plant a session transcript on A under a project root that lives under tmp.
    const projectRoot = join(tmp, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    const sessionContent = '{"role":"user","text":"hello from A"}\n';
    const sid = plantLocalSession(a.home, projectRoot, sessionContent);

    // Host A: init with --snapshot to capture the seeded ~/.claude content.
    // --keep-actions prevents the gh-actions disable flow from running in CI.
    const initResult = runNomad(a, ['init', '--snapshot', '--keep-actions']);
    expect(initResult.status, `init failed:\n${initResult.stderr}`).toBe(0);

    // Commit the scaffold written by init so the files are tracked in origin
    // before push runs. A human user does this after reviewing the scaffold
    // (nomad init writes files but does not auto-commit). Committing here lets
    // nomad push see only the subsequent path-map and session changes as new
    // status lines, keeping them within the push allow-list.
    g(['add', '-A'], a.repo);
    g(['commit', '-q', '-m', 'nomad init scaffold'], a.repo);
    g(['push', '-q', 'origin', 'main'], a.repo);

    // Assert init --snapshot actually scaffolded the settings split, so a
    // regression in what init writes fails here rather than only surfacing
    // downstream as a confusing settings or symlink mismatch on B.
    const scaffolded = gitOut(['show', '--name-only', '--format=', 'HEAD'], a.repo);
    expect(scaffolded, 'init scaffold missing settings.base.json').toContain(
      'shared/settings.base.json',
    );
    expect(scaffolded, 'init scaffold missing hosts/host-a.json').toContain('hosts/host-a.json');

    // Update A's path-map.json to map the logical project under BOTH hosts so
    // remapPush (on A) and remapPull (on B) both resolve the transcript.
    // B's project path is distinct from A's so encodePath produces a different key.
    const bProjectRoot = join(tmp, 'host-b', 'myproject');
    mkdirSync(bProjectRoot, { recursive: true });
    const pathMapPath = join(a.repo, 'path-map.json');
    const pathMap = {
      projects: {
        myproject: {
          'host-a': projectRoot,
          'host-b': bProjectRoot,
        },
      },
    };
    writeFileSync(pathMapPath, JSON.stringify(pathMap) + '\n');

    // Host A: push the session transcript and updated path-map to the shared origin.
    const pushResult = runNomad(a, ['push']);
    expect(pushResult.status, `push failed:\n${pushResult.stderr}`).toBe(0);

    // Mint host B AFTER the push so its clone of origin already contains the
    // scaffolded repo (shared/settings.base.json, path-map.json, and the
    // pushed session transcript). This mirrors a second user doing
    // `git clone <origin> ~/claude-nomad` then `nomad pull`.
    const b = makeHost('host-b');

    // Host B: pull from the shared origin.
    const pullResult = runNomad(b, ['pull']);
    expect(pullResult.status, `pull failed:\n${pullResult.stderr}`).toBe(0);

    // Assertion 1: SHARED_LINKS symlinks resolve on B.
    // Only assert the names that were seeded on A (CLAUDE.md and commands/).
    // rules/ and my-statusline.cjs were not seeded so they have no shared/ target;
    // applySharedLinks skips a link when shared/<name> does not exist.
    const seededLinks = ['CLAUDE.md', 'commands'] as const;
    for (const name of seededLinks) {
      const linkPath = join(b.claudeHome, name);
      expect(lstatSync(linkPath).isSymbolicLink(), `${name} is not a symlink on B`).toBe(true);
      expect(existsSync(linkPath), `symlink ${name} target does not exist on B`).toBe(true);
    }
    // Verify the seeded content is visible through the symlink on B.
    const bClaudeMd = readFileSync(join(b.claudeHome, 'CLAUDE.md'), 'utf8');
    expect(bClaudeMd).toBe('# shared claude md\n');

    // Assertion 2: B's settings.json equals deepMerge(base, hosts/host-b.json).
    // The snapshot wrote the seeded settings.json into hosts/host-a.json.
    // No hosts/host-b.json was pushed so the pull-side merge is base + {}.
    // Compute the oracle by reading the repo files on B's clone.
    const bRepoBase = join(b.repo, 'shared', 'settings.base.json');
    const bRepoHostJson = join(b.repo, 'hosts', 'host-b.json');
    const base = JSON.parse(readFileSync(bRepoBase, 'utf8')) as Record<string, unknown>;
    const hostOverrides = existsSync(bRepoHostJson)
      ? (JSON.parse(readFileSync(bRepoHostJson, 'utf8')) as Record<string, unknown>)
      : {};
    const expectedSettings = deepMerge(base, hostOverrides);
    const actualSettings = JSON.parse(
      readFileSync(join(b.claudeHome, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(actualSettings).toEqual(expectedSettings);

    // Assertion 3: the transcript appears under B's encodePath project dir.
    // The path-map maps 'myproject' to B's distinct bProjectRoot so remapPull
    // on B writes to ~/.claude/projects/<encodePath(bProjectRoot)>/<sid>.jsonl.
    const bEncodedDir = encodePath(bProjectRoot);
    const bSessionPath = join(b.claudeHome, 'projects', bEncodedDir, `${sid}.jsonl`);
    expect(existsSync(bSessionPath), `session not found at ${bSessionPath}`).toBe(true);
    expect(readFileSync(bSessionPath, 'utf8')).toBe(sessionContent);
  });
});
