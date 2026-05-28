import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('remapExtrasPush (integration)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedExtras: string;
  let projectRoot: string;
  let cacheBase: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-push-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedExtras = join(repoUnderHome, 'shared', 'extras');
    projectRoot = join(testHome, 'fake-project');
    cacheBase = join(testHome, '.cache', 'claude-nomad', 'backup');
    mapPath = join(repoUnderHome, 'path-map.json');
    mkdirSync(sharedExtras, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies <localRoot>/.planning/ into shared/extras/<logical>/.planning/ byte-equal', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110000');

    const repoFile = join(sharedExtras, 'foo', '.planning', 'PLAN.md');
    expect(existsSync(repoFile)).toBe(true);
    expect(readFileSync(repoFile, 'utf8')).toBe('# plan\n');
    // Wet copy records the `<logical>/<dirname>` item in `pushed`.
    expect(result).toEqual({
      unmapped: 0,
      skipped: 0,
      pushed: ['foo/.planning'],
      wouldPush: [],
    });
  });

  it('skips non-whitelisted dir names (SUPPORTED_EXTRAS guard) with no log line', async () => {
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'evil.js'), '// evil\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['node_modules'] },
      }) + '\n',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110001');

    expect(existsSync(join(sharedExtras, 'foo', 'node_modules'))).toBe(false);
    // The skipped count still increments (unaffected by quiet) ...
    expect(result).toMatchObject({ unmapped: 0, skipped: 1 });
    expect(result.pushed).toEqual([]);
    expect(result.wouldPush).toEqual([]);
    // ... but the per-skip narration was removed (skips are silent, counted
    // only), so no SUPPORTED_EXTRAS skip line reaches the console.
    const skipLine = logSpy.mock.calls
      .map((args) => args.join(' '))
      .find((line) => line.includes('node_modules') && line.includes('SUPPORTED_EXTRAS'));
    expect(skipLine).toBeUndefined();
  });

  it('counts unmapped projects (TBD host path) and does not copy', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': 'TBD' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110002');

    expect(result).toEqual({ unmapped: 1, skipped: 0, pushed: [], wouldPush: [] });
    expect(existsSync(join(sharedExtras, 'foo'))).toBe(false);
  });

  it('dry-run mode: no write to shared/extras and no backup files created', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110003', { dryRun: true });

    // dryRun records the would-be-pushed item in `wouldPush`, copies nothing.
    expect(result).toEqual({ unmapped: 0, skipped: 0, pushed: [], wouldPush: ['foo/.planning'] });
    expect(existsSync(join(sharedExtras, 'foo'))).toBe(false);
    expect(existsSync(join(cacheBase, '20260522-110003'))).toBe(false);
  });

  it('absence of extras key is a clean no-op (D-03 additive contract)', async () => {
    writeFileSync(
      mapPath,
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110004');

    expect(result).toEqual({ unmapped: 0, skipped: 0, pushed: [], wouldPush: [] });
    expect(existsSync(join(sharedExtras, 'foo'))).toBe(false);
  });

  it('backs up prior shared/extras content to .../backup/<ts>/repo/ before clobber', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'old.md'), 'old\n');
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'new.md'), 'new\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    remapExtrasPush('20260522-110005');

    const backupOld = join(
      cacheBase,
      '20260522-110005',
      'repo',
      'shared',
      'extras',
      'foo',
      '.planning',
      'old.md',
    );
    expect(existsSync(backupOld)).toBe(true);
    expect(readFileSync(backupOld, 'utf8')).toBe('old\n');

    // Mirror copy: old is gone from the repo side, new is in its place.
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'old.md'))).toBe(false);
    expect(readFileSync(join(sharedExtras, 'foo', '.planning', 'new.md'), 'utf8')).toBe('new\n');
  });

  it('silently skips dirnames whose src directory does not exist on this host', async () => {
    // Host opted into `.planning` but hasn't created the dir yet (first-time
    // scenario). Push must silently continue so "opting in is safe even with
    // no content yet" holds. <projectRoot>/.planning intentionally NOT created.
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPush } = await import('./extras-sync.ts');
    expect(() => remapExtrasPush('20260522-no-src-push')).not.toThrow();
    expect(existsSync(join(sharedExtras, 'foo', '.planning'))).toBe(false);
  });

  it('copies a single root file <localRoot>/CLAUDE.md into shared/extras/<logical>/CLAUDE.md, creating the missing logical dir', async () => {
    // Single-file extras case. shared/extras/foo/ does NOT pre-exist; a real
    // gap (cpSync recursive must create the intermediate parent for a file
    // copy) would surface here as an ENOENT.
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# project rules\n');
    expect(existsSync(join(sharedExtras, 'foo'))).toBe(false);
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['CLAUDE.md'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110006');

    const repoFile = join(sharedExtras, 'foo', 'CLAUDE.md');
    expect(existsSync(repoFile)).toBe(true);
    expect(readFileSync(repoFile, 'utf8')).toBe('# project rules\n');
    expect(result).toEqual({
      unmapped: 0,
      skipped: 0,
      pushed: ['foo/CLAUDE.md'],
      wouldPush: [],
    });
  });
});
