import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('remapExtrasPull (integration)', () => {
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
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-pull-test-home-'));
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

  it('copies shared/extras/<logical>/.planning/ into <localRoot>/.planning/ byte-equal', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120000');

    const localFile = join(projectRoot, '.planning', 'PLAN.md');
    expect(existsSync(localFile)).toBe(true);
    expect(readFileSync(localFile, 'utf8')).toBe('# plan\n');
    // Wet copy records the `<logical>/<dirname>` item in `pulled`.
    expect(result).toEqual({
      unmapped: 0,
      skipped: 0,
      pulled: ['foo/.planning'],
      wouldPull: [],
    });
  });

  it('skips non-whitelisted dir names (SUPPORTED_EXTRAS guard) with no log line', async () => {
    mkdirSync(join(sharedExtras, 'foo', 'node_modules'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'node_modules', 'evil.js'), '// evil\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['node_modules'] },
      }) + '\n',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120001');

    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(false);
    // The skipped count still increments (unaffected by quiet) ...
    expect(result).toMatchObject({ unmapped: 0, skipped: 1 });
    expect(result.pulled).toEqual([]);
    expect(result.wouldPull).toEqual([]);
    // ... but the per-skip narration is routed through quiet=true, so no
    // SUPPORTED_EXTRAS skip line reaches the console.
    const skipLine = logSpy.mock.calls
      .map((args) => args.join(' '))
      .find((line) => line.includes('node_modules') && line.includes('SUPPORTED_EXTRAS'));
    expect(skipLine).toBeUndefined();
  });

  it('counts unmapped projects (TBD host path) and does not copy', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': 'TBD' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120002');

    expect(result).toEqual({ unmapped: 1, skipped: 0, pulled: [], wouldPull: [] });
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
  });

  it('dry-run mode: no write to localRoot and no backup files created', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120003', { dryRun: true });

    // dryRun records the would-be-pulled item in `wouldPull`, copies nothing.
    expect(result).toEqual({ unmapped: 0, skipped: 0, pulled: [], wouldPull: ['foo/.planning'] });
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
    expect(existsSync(join(cacheBase, '20260522-120003'))).toBe(false);
  });

  it('absence of extras key is a clean no-op (D-03 additive contract)', async () => {
    writeFileSync(
      mapPath,
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120004');

    expect(result).toEqual({ unmapped: 0, skipped: 0, pulled: [], wouldPull: [] });
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
  });

  it('backs up prior <localRoot>/.planning/ to .../backup/<ts>/extras/<encoded>/ via backupExtrasWrite', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'old.md'), 'old\n');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'new.md'), 'new\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const { encodePath } = await import('./utils.json.ts');
    remapExtrasPull('20260522-120005');

    // backupExtrasWrite layout: <ts>/extras/<encoded-projectRoot>/<rel>/,
    // namespaced by encodePath(projectRoot) so same-relative-path projects
    // do not collide.
    const backupOld = join(
      cacheBase,
      '20260522-120005',
      'extras',
      encodePath(projectRoot),
      '.planning',
      'old.md',
    );
    expect(existsSync(backupOld)).toBe(true);
    expect(readFileSync(backupOld, 'utf8')).toBe('old\n');

    // Mirror copy: old is gone, new is in place.
    expect(existsSync(join(projectRoot, '.planning', 'old.md'))).toBe(false);
    expect(readFileSync(join(projectRoot, '.planning', 'new.md'), 'utf8')).toBe('new\n');
  });

  it('preserves relative symlink targets verbatim across the pull (Pitfall 1 regression)', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'real content\n');
    symlinkSync('PLAN.md', join(sharedExtras, 'foo', '.planning', 'PLAN-link.md'));
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260522-120006');

    // Relative symlink target survives verbatim, not rewritten to an absolute
    // path into the source tree.
    expect(readlinkSync(join(projectRoot, '.planning', 'PLAN-link.md'))).toBe('PLAN.md');
  });

  it('silently skips dirnames whose src does not exist in shared/extras/', async () => {
    // First pull on a fresh host where the logical is opted-in but nobody has
    // pushed extras content yet. Must continue silently so onboarding does not
    // fail. shared/extras/foo/.planning intentionally NOT created.
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPull } = await import('./extras-sync.ts');
    expect(() => remapExtrasPull('20260522-no-src-pull')).not.toThrow();
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
  });

  it('copies shared/extras/<logical>/CLAUDE.md back to <localRoot>/CLAUDE.md byte-equal', async () => {
    mkdirSync(join(sharedExtras, 'foo'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# incoming rules\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['CLAUDE.md'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120007');

    const localFile = join(projectRoot, 'CLAUDE.md');
    expect(existsSync(localFile)).toBe(true);
    expect(readFileSync(localFile, 'utf8')).toBe('# incoming rules\n');
    expect(result).toEqual({
      unmapped: 0,
      skipped: 0,
      pulled: ['foo/CLAUDE.md'],
      wouldPull: [],
    });
  });

  it('backs up a prior <localRoot>/CLAUDE.md before overwriting it on pull', async () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# original rules\n');
    mkdirSync(join(sharedExtras, 'foo'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# replacement rules\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['CLAUDE.md'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const { encodePath } = await import('./utils.json.ts');
    remapExtrasPull('20260522-120008');

    // relative(projectRoot, <root file>) is the basename, so the backup lands
    // directly under the encoded-projectRoot namespace.
    const backupOld = join(
      cacheBase,
      '20260522-120008',
      'extras',
      encodePath(projectRoot),
      'CLAUDE.md',
    );
    expect(existsSync(backupOld)).toBe(true);
    expect(readFileSync(backupOld, 'utf8')).toBe('# original rules\n');

    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe('# replacement rules\n');
  });
});
