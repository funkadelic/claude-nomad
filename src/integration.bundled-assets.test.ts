import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { plantLocalSession } from './test-support/git.ts';
import { makeWorld, runNomad } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. `makeWorld` clones a
 * bare origin per host, so the whole describe skips cleanly without git rather
 * than failing with a spawn error.
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
 * Returns `true` when the `gitleaks` binary is present on PATH. Only the
 * allowlist case below needs it, so it gates that `it` rather than widening the
 * describe: without the binary the shared scan is skipped and the row this test
 * matches on is never emitted, which would read as an opaque regex mismatch.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Guards the package-root asset lookups against the compiled bundle, which is
 * the artifact users install and which resolves them from a different directory
 * depth than `src/` does.
 *
 * These rows are the visible symptom of that lookup: both are read out of the
 * package-root `package.json`, and both call sites turn any read failure into a
 * silent skip. Every unit test for them stubs the read by path suffix, so a
 * lookup that resolves nowhere leaves the whole suite green while the shipped
 * binary quietly stops reporting its own version. `runNomad` spawns the
 * esbuild bundle from `.test-bundle/`, placed at the same depth as `dist/`, so
 * these assertions exercise the real resolution path.
 *
 * The scanner-config case below guards a third package-root lookup:
 * `resolveTomlPath` (`src/commands/push/gitleaks.config.ts`) locates the
 * package-bundled `.gitleaks.toml` via the same `packageRoot()` walk. Unlike
 * the two version rows, a resolution failure there is silent in a different,
 * more dangerous way: callers omit `--config` on a `null` return, so the scan
 * still runs and still reports clean, just against gitleaks' stock ruleset
 * instead of this repo's allowlist. The unit tests for it stub the filesystem
 * probe, so they cannot tell the compiled bundle's real depth apart from a
 * broken one; this test proves the allowlist is active in the shipped binary.
 */
describe.skipIf(!hasGit)('bundled binary package-root lookups', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-bundled-assets-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports its own version from the compiled bundle', () => {
    const { makeHost } = makeWorld(tmp);
    const host = makeHost('host-a');

    const { stdout } = runNomad(host, ['doctor']);

    expect(stdout).toMatch(/claude-nomad: \d+\.\d+\.\d+/);
  });

  it('reports the required node engine from the compiled bundle', () => {
    const { makeHost } = makeWorld(tmp);
    const host = makeHost('host-a');

    const { stdout } = runNomad(host, ['doctor', '--verbose']);

    expect(stdout).toMatch(/node: v\d+/);
  });

  it.skipIf(!hasGitleaks)(
    'resolves the bundled gitleaks allowlist from the compiled bundle',
    () => {
      const { makeHost } = makeWorld(tmp);
      const host = makeHost('host-a');

      // Map a logical project to a local root for this host so
      // `doctor --check-shared` finds a session to stage and scan.
      const projectRoot = join(host.home, 'fake-project');
      writeFileSync(
        join(host.repo, 'path-map.json'),
        JSON.stringify({ projects: { foo: { [host.hostname]: projectRoot } } }),
      );

      // Plant the first documented test-fixture PAT this repo's own
      // .gitleaks.toml allowlists (path-scoped to synced session transcripts).
      // Chosen over the other three documented literals because it has enough
      // entropy to trip gitleaks' stock github-pat rule on its own (verified:
      // the sequential-alphabet variants do not); only the custom allowlist
      // suppresses it. Assembled from fragments so the contiguous token shape
      // never appears in source-controlled bytes: this repo's own CI gitleaks
      // scan would otherwise flag this file.
      const fakePat = ['gh', 'p_', 'xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA'].join('');
      plantLocalSession(host.home, projectRoot, `{"role":"user","text":"${fakePat}"}\n`);

      const { stdout } = runNomad(host, ['doctor', '--check-shared']);

      // If packageRoot() failed to resolve the bundled .gitleaks.toml at the
      // compiled binary's own depth, resolveTomlPath would return null,
      // --config would be omitted, and gitleaks' stock ruleset (no allowlist)
      // would still flag this PAT as a leak. A clean result is only possible
      // when the bundled allowlist actually resolved.
      //
      // The count is anchored so a future multi-project fixture cannot satisfy
      // this with "11 project(s)". The process exit code is deliberately NOT
      // asserted: it reports the whole doctor run, and this synthetic host trips
      // unrelated checks, so pinning it would couple this test to every other
      // row rather than to the allowlist resolution it exists to prove.
      expect(stdout).toMatch(/(?<!\d)1 project\(s\) scanned, no leaks/);
    },
  );
});
