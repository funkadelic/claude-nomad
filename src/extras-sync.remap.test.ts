import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `remapExtrasPush` and `remapExtrasPull` focusing on the two
 * behavioral survivors from the Phase-46 Stryker sweep:
 *
 * - L85 BooleanLiteral: `if (!dryRun) mkdirSync(repoExtras, { recursive: true })`
 *   A `true` mutation would only call `mkdirSync` on the dryRun path, so the
 *   wet push would fail if `shared/extras/` did not already exist.
 *
 * - L121 BooleanLiteral: `requireRepoExtras: true` in `remapExtrasPull`'s
 *   `loadValidatedExtras` call. A `false` mutation means pull would skip the
 *   `shared/extras/` existence check and proceed even when the directory is
 *   absent; it would then copy from non-existent source paths silently.
 */

/**
 * Minimal path-map.json with an extras opt-in for the test project.
 * localRoot is set to an actual directory so the guards pass.
 */
function makePathMap(localRoot: string): string {
  return JSON.stringify({
    projects: { testproject: { 'test-host': localRoot } },
    extras: { testproject: ['.planning'] },
  });
}

describe('remapExtrasPush: wet push creates shared/extras/ when absent (L85 BooleanLiteral)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoHome: string;
  let projectRoot: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extrasremap-push-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoHome = join(testHome, 'claude-nomad');
    process.env.NOMAD_REPO = repoHome;
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(repoHome, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# state\n');
    writeFileSync(join(repoHome, 'path-map.json'), makePathMap(projectRoot));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('creates shared/extras/ on a wet push even when the directory did not previously exist', async () => {
    // shared/extras/ must NOT exist before the push; the wet path must create it.
    const repoExtras = join(repoHome, 'shared', 'extras');
    expect(existsSync(repoExtras)).toBe(false);

    const { remapExtrasPush } = await import('./extras-sync.remap.ts');
    const result = remapExtrasPush('20260516-000000');

    // The push succeeded and shared/extras/ was created by mkdirSync.
    expect(existsSync(repoExtras)).toBe(true);
    // The .planning item was pushed.
    expect(result.pushed).toContain('testproject/.planning');
  });

  it('does NOT create shared/extras/ on a dry-run push (zero-mutation contract)', async () => {
    const repoExtras = join(repoHome, 'shared', 'extras');
    expect(existsSync(repoExtras)).toBe(false);

    const { remapExtrasPush } = await import('./extras-sync.remap.ts');
    const result = remapExtrasPush('20260516-000000', { dryRun: true });

    // dry-run must not create directories.
    expect(existsSync(repoExtras)).toBe(false);
    // The item appears in wouldPush, not pushed.
    expect(result.wouldPush).toContain('testproject/.planning');
    expect(result.pushed).toHaveLength(0);
  });
});

describe('remapExtrasPull: returns empty when shared/extras/ is absent (L121 BooleanLiteral)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoHome: string;
  let projectRoot: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extrasremap-pull-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoHome = join(testHome, 'claude-nomad');
    process.env.NOMAD_REPO = repoHome;
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(repoHome, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(repoHome, 'path-map.json'), makePathMap(projectRoot));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns empty arrays and zero counts when shared/extras/ is absent', async () => {
    // shared/extras/ does not exist; requireRepoExtras:true must cause early exit.
    const repoExtras = join(repoHome, 'shared', 'extras');
    expect(existsSync(repoExtras)).toBe(false);

    const { remapExtrasPull } = await import('./extras-sync.remap.ts');
    const result = remapExtrasPull('20260516-000000');

    expect(result.pulled).toHaveLength(0);
    expect(result.wouldPull).toHaveLength(0);
    expect(result.unmapped).toBe(0);
    expect(result.skipped).toBe(0);
    // shared/extras/ must remain absent (no side-effects on missing-prereq exit).
    expect(existsSync(repoExtras)).toBe(false);
  });

  it('pulls items when shared/extras/ exists with content', async () => {
    // shared/extras/ and the project entry must both exist for pull to copy.
    const repoExtras = join(repoHome, 'shared', 'extras');
    mkdirSync(join(repoExtras, 'testproject', '.planning'), { recursive: true });
    writeFileSync(join(repoExtras, 'testproject', '.planning', 'STATE.md'), '# state\n');

    const { remapExtrasPull } = await import('./extras-sync.remap.ts');
    const result = remapExtrasPull('20260516-000000');

    expect(result.pulled).toContain('testproject/.planning');
    expect(result.pulled).toHaveLength(1);
  });
});
