import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PathMap } from './config.ts';
import { stubPlatform } from './test-helpers.platform.ts';

const realPlatform = process.platform;

/**
 * Permission-based failure injection is a no-op on Windows, where `chmod` does
 * not restrict access; the branch it covers is counted on the posix leg.
 */
const isWin = realPlatform === 'win32';

/**
 * Recursively snapshot `{ relativePath: content }` for every regular file
 * under `root`, POSIX-separated so the map is comparable regardless of which
 * OS produced the paths. Used to assert the planner mutates nothing, and to
 * derive the set of repo-side files a wet run actually touched.
 */
function snapshotFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        out.set(relative(root, abs).split(sep).join('/'), readFileSync(abs, 'utf8'));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Assert two name sets are equal, with a failure message naming which side
 * carries the extra name. Plain `toEqual` on a `Set` also fails correctly,
 * but this pinpoints the offending side directly rather than requiring the
 * reader to diff two full sets by hand.
 */
function assertNameSetsEqual(planned: Set<string>, wet: Set<string>): void {
  const onlyPlanned = [...planned].filter((n) => !wet.has(n)).sort();
  const onlyWet = [...wet].filter((n) => !planned.has(n)).sort();
  expect({ onlyInPlanner: onlyPlanned, onlyInRealMirror: onlyWet }).toEqual({
    onlyInPlanner: [],
    onlyInRealMirror: [],
  });
}

describe('planSharedLinkCaptures', () => {
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
    testHome = mkdtempSync(join(tmpdir(), 'nomad-captures-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO over the $HOME fallback these fixtures
    // assume, so an ambient export would aim the mirror at a real checkout.
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
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

  describe('individual gates', () => {
    it('returns an empty array on a non-win32 platform, never touching the repo', async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
      stubPlatform('darwin');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      expect(planSharedLinkCaptures({ projects: {} })).toEqual([]);
    });

    it('returns an empty array when the map is null', async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      expect(planSharedLinkCaptures(null)).toEqual([]);
    });

    it('skips a name whose local path is absent', async () => {
      mkdirSync(join(sharedDir, 'rules'), { recursive: true });
      writeFileSync(join(sharedDir, 'rules', 'r.md'), '# shared rules\n');
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      const plan = planSharedLinkCaptures({ projects: {} });
      expect(plan.some((e) => e.name === 'rules')).toBe(false);
    });

    it('skips a name whose local path is a live symlink', async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      const outside = join(testHome, 'outside-claude.md');
      writeFileSync(outside, '# outside\n');
      symlinkSync(outside, join(claudeDir, 'CLAUDE.md'));
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      const plan = planSharedLinkCaptures({ projects: {} });
      expect(plan.some((e) => e.name === 'CLAUDE.md')).toBe(false);
    });

    it.skipIf(isWin)('skips a name whose local path cannot be stat-ed at all', async () => {
      // `throwIfNoEntry: false` suppresses ENOENT only, so a locked path still
      // throws. This planner is reached by `nomad diff` and `pull --dry-run`,
      // whose whole value is being safe to run.
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
      chmodSync(claudeDir, 0o000);
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      try {
        expect(planSharedLinkCaptures({ projects: {} })).toEqual([]);
      } finally {
        chmodSync(claudeDir, 0o700);
      }
    });

    it('skips a name with no shared/<name> counterpart in the repo', async () => {
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local only, never shared\n');
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      const plan = planSharedLinkCaptures({ projects: {} });
      expect(plan.some((e) => e.name === 'CLAUDE.md')).toBe(false);
    });

    it('includes a present file and a present directory, each with local and repo paths', async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
      mkdirSync(join(sharedDir, 'commands'), { recursive: true });
      writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared foo\n');
      mkdirSync(join(claudeDir, 'commands'), { recursive: true });
      writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local foo\n');
      stubPlatform('win32');
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      const plan = planSharedLinkCaptures({ projects: {} });
      const byName = new Map(plan.map((e) => [e.name, e]));
      expect(byName.get('CLAUDE.md')).toEqual({
        name: 'CLAUDE.md',
        localPath: join(claudeDir, 'CLAUDE.md'),
        repoPath: join(sharedDir, 'CLAUDE.md'),
      });
      expect(byName.get('commands')).toEqual({
        name: 'commands',
        localPath: join(claudeDir, 'commands'),
        repoPath: join(sharedDir, 'commands'),
      });
    });
  });

  describe('equivalence with the real mirror', () => {
    /**
     * Build one fixture covering every gate: a present file with a repo
     * counterpart (mirrored), a present directory with a repo counterpart
     * (mirrored), a repo-only name absent locally (skipped), a locally
     * live-symlinked name (skipped), and a locally-present name with no repo
     * counterpart yet (skipped, since the mirror never adopts a new name).
     */
    function buildFixture(): PathMap {
      // Present file, repo counterpart exists: mirrored.
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-claude-old\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-claude\n');

      // Present directory, repo counterpart exists: mirrored (overlay).
      mkdirSync(join(sharedDir, 'commands'), { recursive: true });
      writeFileSync(join(sharedDir, 'commands', 'foo.md'), '# shared-foo-old\n');
      mkdirSync(join(claudeDir, 'commands'), { recursive: true });
      writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local-foo\n');

      // Repo-only: nothing locally, so there is nothing to mirror.
      mkdirSync(join(sharedDir, 'rules'), { recursive: true });
      writeFileSync(join(sharedDir, 'rules', 'r.md'), '# shared-rules-old\n');

      // Live symlink locally: skipped even though a repo counterpart exists.
      writeFileSync(join(sharedDir, 'my-statusline.cjs'), '// shared-statusline-old\n');
      const outsideTarget = join(testHome, 'outside-statusline.cjs');
      writeFileSync(outsideTarget, '// outside\n');
      symlinkSync(outsideTarget, join(claudeDir, 'my-statusline.cjs'));

      // Present locally, but the repo has never shared this name: skipped
      // (adoptNew: false, matched by the planner's no-counterpart gate).
      mkdirSync(join(claudeDir, 'extra-tool'), { recursive: true });
      writeFileSync(join(claudeDir, 'extra-tool', 'e.md'), '# local-extra\n');

      return { projects: {}, sharedDirs: ['extra-tool'] };
    }

    it('the planner name set equals the set of names the real mirror actually writes', async () => {
      const map = buildFixture();

      stubPlatform('win32');
      const before = snapshotFiles(sharedDir);
      const { planSharedLinkCaptures } = await import('./links.captures.ts');
      const plan = planSharedLinkCaptures(map);
      const plannedNames = new Set(plan.map((e) => e.name));

      // The planner is read-only: planning must not have touched the repo.
      expect(snapshotFiles(sharedDir)).toEqual(before);

      // Fresh module instance for the wet run so no planner side effects
      // (there are none, but this matches the established isolation pattern)
      // leak into the mirror's own execution.
      vi.resetModules();
      const { stageLocalSharedEdits } = await import('./links.ts');
      stageLocalSharedEdits(map, '20260803-120000');
      const after = snapshotFiles(sharedDir);

      const wetWrittenNames = new Set<string>();
      for (const [relPath, content] of after) {
        if (before.get(relPath) !== content) wetWrittenNames.add(relPath.split('/')[0]);
      }
      for (const relPath of before.keys()) {
        if (!after.has(relPath)) wetWrittenNames.add(relPath.split('/')[0]);
      }

      assertNameSetsEqual(plannedNames, wetWrittenNames);
      // Pin the concrete expectation too, so a gate silently broken on both
      // sides at once cannot pass by quiet mutual agreement on the wrong set.
      expect([...plannedNames].sort()).toEqual(['CLAUDE.md', 'commands']);
    });
  });
});
