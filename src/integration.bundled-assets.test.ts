import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
