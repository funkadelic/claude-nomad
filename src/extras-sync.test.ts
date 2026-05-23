import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('copyExtras (file-local helper)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    src = join(testHome, 'src-tree');
    dst = join(testHome, 'dst-tree');
    mkdirSync(src, { recursive: true });
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

  it('byte-equal mirror of a plain tree (markdown, JSON, nested text)', async () => {
    writeFileSync(join(src, 'top.md'), '# top\n');
    writeFileSync(join(src, 'top.json'), '{"a":1}\n');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'nested', 'deep.txt'), 'deep-bytes');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readFileSync(join(dst, 'top.md'), 'utf8')).toBe('# top\n');
    expect(readFileSync(join(dst, 'top.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(dst, 'nested', 'deep.txt'), 'utf8')).toBe('deep-bytes');
  });

  it('preserves relative symlink targets verbatim (verbatimSymlinks: true; Pitfall 1)', async () => {
    writeFileSync(join(src, 'target.md'), 'real content\n');
    symlinkSync('target.md', join(src, 'link.md'));

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    // The symlink target must be the original relative string, not rewritten
    // to an absolute path into the source tree (Pitfall 1 mitigation).
    expect(readlinkSync(join(dst, 'link.md'))).toBe('target.md');
  });

  it('propagates empty subdirectories to the destination', async () => {
    mkdirSync(join(src, 'sub', 'empty'), { recursive: true });

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(existsSync(join(dst, 'sub', 'empty'))).toBe(true);
    expect(readdirSync(join(dst, 'sub', 'empty'))).toEqual([]);
  });

  it('mirror semantics: dst-only files are removed (rmSync-then-cpSync)', async () => {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'stale.md'), 'stale\n');
    writeFileSync(join(src, 'fresh.md'), 'fresh\n');

    const { copyExtras } = await import('./extras-sync.ts');
    copyExtras(src, dst);

    expect(readdirSync(dst).sort()).toEqual(['fresh.md']);
    expect(readFileSync(join(dst, 'fresh.md'), 'utf8')).toBe('fresh\n');
  });
});

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
    expect(result).toEqual({ unmapped: 0, skipped: 0 });
  });

  it('skips non-whitelisted dir names (SUPPORTED_EXTRAS guard) with a log line', async () => {
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
    expect(result).toEqual({ unmapped: 0, skipped: 1 });
    const skipLine = logSpy.mock.calls
      .map((args) => args.join(' '))
      .find((line) => line.includes('node_modules') && line.includes('SUPPORTED_EXTRAS'));
    expect(skipLine).toBeDefined();
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

    expect(result).toEqual({ unmapped: 1, skipped: 0 });
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

    expect(result).toEqual({ unmapped: 0, skipped: 0 });
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

    expect(result).toEqual({ unmapped: 0, skipped: 0 });
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

    // The mirror copy means the old file is gone from the repo side and the
    // new file is now in its place.
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'old.md'))).toBe(false);
    expect(readFileSync(join(sharedExtras, 'foo', '.planning', 'new.md'), 'utf8')).toBe('new\n');
  });
});

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
    expect(result).toEqual({ unmapped: 0, skipped: 0 });
  });

  it('skips non-whitelisted dir names (SUPPORTED_EXTRAS guard) with a log line', async () => {
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
    expect(result).toEqual({ unmapped: 0, skipped: 1 });
    const skipLine = logSpy.mock.calls
      .map((args) => args.join(' '))
      .find((line) => line.includes('node_modules') && line.includes('SUPPORTED_EXTRAS'));
    expect(skipLine).toBeDefined();
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

    expect(result).toEqual({ unmapped: 1, skipped: 0 });
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

    expect(result).toEqual({ unmapped: 0, skipped: 0 });
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

    expect(result).toEqual({ unmapped: 0, skipped: 0 });
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
  });

  it('backs up prior <localRoot>/.planning/ to .../backup/<ts>/extras/ via backupExtrasWrite', async () => {
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
    remapExtrasPull('20260522-120005');

    // backupExtrasWrite uses the extras/-prefix path layout. Backup root is
    // ~/.cache/claude-nomad/backup/<ts>/extras/<rel-to-localRoot>/.
    const backupOld = join(cacheBase, '20260522-120005', 'extras', '.planning', 'old.md');
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

    // The relative symlink target survives the pull verbatim, not rewritten
    // to an absolute path into the source tree.
    expect(readlinkSync(join(projectRoot, '.planning', 'PLAN-link.md'))).toBe('PLAN.md');
  });
});
