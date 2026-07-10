import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression lock: proves the dry-run preview Extras items are identical to
 * the items a wet pull would copy for the same starting state, including a
 * wholly-missing-local extra (a freshly cloned project that never received
 * `.planning`/`CLAUDE.md`). Both `wouldPull` (dry) and `pulled` (wet) derive
 * from the same `runExtrasOp` loop in `extras-sync.remap.ts`, so they must
 * name the same `<logical>/<dirname>` set for an identical starting state.
 * No production code changes; this is coverage over Task 1's behavior.
 */
describe('preview extras parity (dry-run vs wet)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let hostsDir: string;
  let sharedProjects: string;
  let fooLocal: string;
  let barLocal: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    testHome = mkdtempSync(join(tmpdir(), 'nomad-preview-extras-parity-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    hostsDir = join(repoUnderHome, 'hosts');
    sharedProjects = join(sharedDir, 'projects');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(hostsDir, { recursive: true });
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');

    // Repo-side extras: foo/.planning (a directory extra) and bar/CLAUDE.md
    // (a single root-level file extra), both whitelisted names.
    const repoExtrasFoo = join(sharedDir, 'extras', 'foo', '.planning');
    mkdirSync(repoExtrasFoo, { recursive: true });
    writeFileSync(join(repoExtrasFoo, 'PROJECT.md'), '# project\n');
    const repoExtrasBar = join(sharedDir, 'extras', 'bar');
    mkdirSync(repoExtrasBar, { recursive: true });
    writeFileSync(join(repoExtrasBar, 'CLAUDE.md'), '# claude bar\n');

    // foo's local project directory is never created: the wholly-missing-
    // local case. bar's local project directory exists but has no CLAUDE.md
    // yet (a normal first-sync case).
    fooLocal = join(testHome, 'never-created', 'foo');
    barLocal = join(testHome, 'projects', 'bar');
    mkdirSync(barLocal, { recursive: true });
    expect(existsSync(fooLocal)).toBe(false);

    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': fooLocal },
          bar: { 'test-host': barLocal },
        },
        extras: { foo: ['.planning'], bar: ['CLAUDE.md'] },
      }) + '\n',
    );

    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('remapExtrasPull dry-run wouldPull deep-equals the wet pulled set, including the missing-local extra', async () => {
    const { remapExtrasPull } = await import('./extras-sync.ts');

    // Capture the dry-run result FIRST so the wet call's mutation (copying
    // into fooLocal/barLocal) does not perturb the dry read.
    const dryResult = remapExtrasPull('20260516-000000', { dryRun: true });
    expect([...dryResult.wouldPull].sort()).toEqual(['bar/CLAUDE.md', 'foo/.planning']);

    const wetResult = remapExtrasPull('20260516-000000');
    expect([...wetResult.pulled].sort()).toEqual([...dryResult.wouldPull].sort());

    // The wholly-missing-local extra appears in BOTH the dry wouldPull and
    // the wet pulled sets, and the wet call actually materialized it.
    expect(dryResult.wouldPull).toContain('foo/.planning');
    expect(wetResult.pulled).toContain('foo/.planning');
    expect(existsSync(join(fooLocal, '.planning', 'PROJECT.md'))).toBe(true);
  });

  it('computePreview renders an Extras header with a row for each expected <logical>/<dirname> entry', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    const joined = logs.join('\n');
    expect(joined).toContain('Extras');
    expect(joined).toContain('foo/.planning');
    expect(joined).toContain('bar/CLAUDE.md');

    // The rendered preview must not have mutated fooLocal (still missing).
    expect(existsSync(fooLocal)).toBe(false);
  });
});
