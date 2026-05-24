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

  it('silently skips dirnames whose src directory does not exist on this host', async () => {
    // The host opted into `.planning` for the project but hasn't created the
    // dir yet (typical first-time scenario before any planning artifacts
    // exist). The push must silently continue rather than error so the
    // user-facing contract "opting in is safe even with no content yet"
    // holds.
    // Note: <projectRoot>/.planning intentionally NOT created.
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
    const { encodePath } = await import('./utils.ts');
    remapExtrasPull('20260522-120005');

    // backupExtrasWrite uses the extras/-prefix path layout, namespaced by
    // encodePath(projectRoot) so two opted-in projects with the same relative
    // extras path do not collide. Layout:
    //   ~/.cache/claude-nomad/backup/<ts>/extras/<encoded-projectRoot>/<rel>/.
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

    // The relative symlink target survives the pull verbatim, not rewritten
    // to an absolute path into the source tree.
    expect(readlinkSync(join(projectRoot, '.planning', 'PLAN-link.md'))).toBe('PLAN.md');
  });

  it('silently skips dirnames whose src does not exist in shared/extras/', async () => {
    // First pull on a fresh host where the logical is opted-in but nobody
    // has pushed extras content for it yet. The pull must continue silently
    // rather than error so a fresh host onboarding does not fail just
    // because a project hasn't materialized its extras yet.
    // Note: shared/extras/foo/.planning intentionally NOT created.
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
});

describe('divergenceCheckExtras (integration)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedExtras: string;
  let projectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-diverge-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedExtras = join(repoUnderHome, 'shared', 'extras');
    projectRoot = join(testHome, 'fake-project');
    mapPath = join(repoUnderHome, 'path-map.json');
    mkdirSync(sharedExtras, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Mirror the `vi.doMock('node:child_process', ...)` calls that the
    // ENOENT and unexpected-git-failure tests register. `vi.restoreAllMocks()`
    // does NOT clear `vi.doMock` module mocks, and the inline
    // `vi.doUnmock` at the end of each test is skipped if any assertion
    // throws first, so without this safety net a failing test would leak
    // the mock into later tests in the file.
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Capture both `process.stderr.write` and `console.error` output and return
   * the concatenated string. The `warn()` helper routes through
   * `console.error` which by default writes to `process.stderr.write`; spying
   * on `console.error` short-circuits that, so both spies are installed in
   * case either path is exercised by future refactors. Returns the joined
   * stderr captures so tests can assert against the WARN glyph and file
   * names.
   */
  const captureStderr = (): { read: () => string } => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });
    return { read: () => writes.join('\n') };
  };

  it('no WARN when local and repo are byte-equal (no divergence)', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    expect(captured.read()).not.toContain('⚠︎');
  });

  it('WARN names the diverging file plus a count summary line', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '{"old":true}\n');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '{"new":true}\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    const output = captured.read();
    expect(output).toContain('PLAN.md');
    expect(output).toMatch(/1 file/);
  });

  it('two diverging files: two file-name WARNs plus one summary WARN', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'local-plan\n');
    writeFileSync(join(projectRoot, '.planning', 'NOTES.md'), 'local-notes\n');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'repo-plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'NOTES.md'), 'repo-notes\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    const output = captured.read();
    expect(output).toContain('PLAN.md');
    expect(output).toContain('NOTES.md');
    expect(output).toMatch(/2 file/);
  });

  it('silently skips when local extras directory is absent', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'repo-only\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    expect(captured.read()).not.toContain('⚠︎');
  });

  it('silently skips when repo extras directory is absent', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'local-only\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    expect(captured.read()).not.toContain('⚠︎');
  });

  it('returns void and does not throw even when divergence is detected', async () => {
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'local\n');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'repo\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    const result = divergenceCheckExtras('20260522-test');

    expect(result).toBeUndefined();
  });

  it('silently skips non-whitelisted dir names (SUPPORTED_EXTRAS guard)', async () => {
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'a.js'), 'local\n');
    mkdirSync(join(sharedExtras, 'foo', 'node_modules'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'node_modules', 'a.js'), 'repo\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['node_modules'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    expect(captured.read()).not.toContain('⚠︎');
  });

  it('silently skips when host path is TBD', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'repo\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': 'TBD' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    expect(captured.read()).not.toContain('⚠︎');
  });
});

describe('extras-sync e2e round-trip', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testRepo: string;
  let hostAHome: string;
  let hostBHome: string;
  let hostAProjectRoot: string;
  let hostBProjectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testRepo = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-repo-'));
    hostAHome = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-hostA-'));
    hostBHome = mkdtempSync(join(tmpdir(), 'nomad-extras-e2e-hostB-'));
    hostAProjectRoot = join(hostAHome, 'fake-project');
    hostBProjectRoot = join(hostBHome, 'fake-project');
    mapPath = join(testRepo, 'path-map.json');
    mkdirSync(hostAProjectRoot, { recursive: true });
    mkdirSync(hostBProjectRoot, { recursive: true });
    // Pin the repo location across both hosts via NOMAD_REPO so HOME mutations
    // do not relocate the shared repo between the push and pull halves.
    process.env.NOMAD_REPO = testRepo;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testRepo, { recursive: true, force: true });
    rmSync(hostAHome, { recursive: true, force: true });
    rmSync(hostBHome, { recursive: true, force: true });
  });

  /**
   * Switch the process env to the named host's identity and reset the module
   * graph so the next dynamic import of `./extras-sync.ts` re-evaluates
   * `HOST` and `REPO_HOME` from `./config.ts` against the new env. Both
   * constants are resolved at module load; without the reset the second
   * host's call would still see the first host's identity.
   */
  function actAsHost(home: string, host: string): void {
    process.env.HOME = home;
    process.env.NOMAD_HOST = host;
    vi.resetModules();
  }

  it('happy path: host A push -> host B pull preserves byte-equality across mixed file types', async () => {
    // Populate host A's project with three artifacts of different content
    // shapes: top-level markdown, nested-dir markdown, and JSON. The
    // composed round-trip must preserve all three byte-for-byte.
    const stateMd = '# state\n\nactive: phase-19\n';
    const planMd = '# plan\n\nstep 1\nstep 2\n';
    const configJson = '{"feature":"extras","enabled":true}\n';
    mkdirSync(join(hostAProjectRoot, '.planning', 'phases', '01'), { recursive: true });
    writeFileSync(join(hostAProjectRoot, '.planning', 'STATE.md'), stateMd);
    writeFileSync(join(hostAProjectRoot, '.planning', 'phases', '01', 'PLAN.md'), planMd);
    writeFileSync(join(hostAProjectRoot, '.planning', 'config.json'), configJson);
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { demo: { 'host-a': hostAProjectRoot, 'host-b': hostBProjectRoot } },
        extras: { demo: ['.planning'] },
      }) + '\n',
    );

    // Push from host A.
    actAsHost(hostAHome, 'host-a');
    const push = await import('./extras-sync.ts');
    const pushResult = push.remapExtrasPush('20260522-100000');
    expect(pushResult).toEqual({ unmapped: 0, skipped: 0 });

    // Shared repo now mirrors host A's .planning/ byte-for-byte.
    const sharedState = join(testRepo, 'shared', 'extras', 'demo', '.planning', 'STATE.md');
    const sharedPlan = join(
      testRepo,
      'shared',
      'extras',
      'demo',
      '.planning',
      'phases',
      '01',
      'PLAN.md',
    );
    const sharedCfg = join(testRepo, 'shared', 'extras', 'demo', '.planning', 'config.json');
    expect(readFileSync(sharedState, 'utf8')).toBe(stateMd);
    expect(readFileSync(sharedPlan, 'utf8')).toBe(planMd);
    expect(readFileSync(sharedCfg, 'utf8')).toBe(configJson);

    // Pull on host B.
    actAsHost(hostBHome, 'host-b');
    const pull = await import('./extras-sync.ts');
    const pullResult = pull.remapExtrasPull('20260522-100001');
    expect(pullResult).toEqual({ unmapped: 0, skipped: 0 });

    // Host B's project root now contains exactly the bytes host A wrote.
    expect(readFileSync(join(hostBProjectRoot, '.planning', 'STATE.md'), 'utf8')).toBe(stateMd);
    expect(
      readFileSync(join(hostBProjectRoot, '.planning', 'phases', '01', 'PLAN.md'), 'utf8'),
    ).toBe(planMd);
    expect(readFileSync(join(hostBProjectRoot, '.planning', 'config.json'), 'utf8')).toBe(
      configJson,
    );
  });

  it('back-compat: legacy path-map without extras key is a clean no-op on push and pull', async () => {
    mkdirSync(join(hostAProjectRoot, '.planning'), { recursive: true });
    writeFileSync(join(hostAProjectRoot, '.planning', 'STATE.md'), '# legacy\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { demo: { 'host-a': hostAProjectRoot, 'host-b': hostBProjectRoot } },
      }) + '\n',
    );

    // Push from host A: no extras key -> clean no-op, shared/extras absent.
    actAsHost(hostAHome, 'host-a');
    const push = await import('./extras-sync.ts');
    const pushResult = push.remapExtrasPush('20260522-100002');
    expect(pushResult).toEqual({ unmapped: 0, skipped: 0 });
    expect(existsSync(join(testRepo, 'shared', 'extras', 'demo'))).toBe(false);

    // Pull on host B: same clean no-op, host B's project is untouched.
    actAsHost(hostBHome, 'host-b');
    const pull = await import('./extras-sync.ts');
    const pullResult = pull.remapExtrasPull('20260522-100003');
    expect(pullResult).toEqual({ unmapped: 0, skipped: 0 });
    expect(existsSync(join(hostBProjectRoot, '.planning'))).toBe(false);
  });
});

describe('assertSafeLogical (path-traversal defense-in-depth)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let projectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-safe-logical-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    projectRoot = join(testHome, 'fake-project');
    mapPath = join(repoUnderHome, 'path-map.json');
    mkdirSync(join(repoUnderHome, 'shared', 'extras'), { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# state\n');
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

  // Each case crafts a path-map.json with a malicious logical key and expects
  // NomadFatal BEFORE any cpSync/write side-effect lands on the filesystem.
  // The push allow-list also catches these eventually, but only after the
  // copy has already mutated state on disk. assertSafeLogical fails fast.
  const malicious = ['../escape', '..', 'foo/bar', 'foo\\bar', '.', 'a/../b'];
  for (const evilKey of malicious) {
    it(`remapExtrasPush rejects logical key ${JSON.stringify(evilKey)} before any write`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPush('20260522-evil')).toThrow(NomadFatal);
      // Confirm no escape-write happened (shared/extras stays empty of crafted keys).
      const repoExtras = join(repoUnderHome, 'shared', 'extras');
      const entries = existsSync(repoExtras)
        ? readdirSync(repoExtras).filter((e) => e === evilKey || e === '..' || e === 'escape')
        : [];
      expect(entries).toEqual([]);
    });

    it(`remapExtrasPull rejects logical key ${JSON.stringify(evilKey)} before any write`, async () => {
      // Set up shared/extras content under a SAFE name first so the
      // existsSync(src) guard would otherwise pass. The crafted KEY is what
      // assertSafeLogical must reject.
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPull } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPull('20260522-evil')).toThrow(NomadFatal);
    });

    it(`divergenceCheckExtras rejects logical key ${JSON.stringify(evilKey)} before any git invocation`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [evilKey]: { 'test-host': projectRoot } },
          extras: { [evilKey]: ['.planning'] },
        }) + '\n',
      );
      const { divergenceCheckExtras } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => divergenceCheckExtras('20260522-evil')).toThrow(NomadFatal);
    });
  }

  it('remapExtrasPush does not mkdir shared/extras/ when a later map entry is poisoned', async () => {
    // Multi-entry guarantee: a clean logical at the head of the map must NOT
    // cause `mkdirSync(shared/extras/)` (or its first cpSync) to land if a
    // poisoned key sits later in iteration order. The validation pass FATALs
    // up-front so the "FATAL before any filesystem mutation" contract holds
    // across the entire map, not just per-entry. Without it, `clean` would
    // race ahead of the FATAL for `../escape`.
    const repoExtras = join(repoUnderHome, 'shared', 'extras');
    // Beat the beforeEach scaffolding so we can prove absence post-call.
    rmSync(repoExtras, { recursive: true, force: true });
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: {
          clean: { 'test-host': projectRoot },
          '../escape': { 'test-host': projectRoot },
        },
        extras: { clean: ['.planning'], '../escape': ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPush } = await import('./extras-sync.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapExtrasPush('20260522-multi-evil')).toThrow(NomadFatal);
    expect(existsSync(repoExtras)).toBe(false);
  });

  it('remapExtrasPull does not clobber host content when a later map entry is poisoned', async () => {
    // Symmetric multi-entry guarantee for pull: a clean logical at the head
    // of the map must NOT trigger `backupExtrasWrite` / `copyExtras` against
    // the host filesystem if a poisoned key sits later in iteration order.
    // Without the validation pass, the host-side `<localRoot>/.planning/`
    // would already be replaced (and backed up) before the FATAL fired for
    // `../escape`, partially mutating user state.
    const repoExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(repoExtras, 'clean', '.planning'), { recursive: true });
    writeFileSync(join(repoExtras, 'clean', '.planning', 'STATE.md'), '# incoming\n');
    const localPlanning = join(projectRoot, '.planning');
    mkdirSync(localPlanning, { recursive: true });
    writeFileSync(join(localPlanning, 'STATE.md'), '# original\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: {
          clean: { 'test-host': projectRoot },
          '../escape': { 'test-host': projectRoot },
        },
        extras: { clean: ['.planning'], '../escape': ['.planning'] },
      }) + '\n',
    );
    const { remapExtrasPull } = await import('./extras-sync.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapExtrasPull('20260522-pull-multi-evil')).toThrow(NomadFatal);
    // Host content untouched: original file still there, no backup written.
    expect(readFileSync(join(localPlanning, 'STATE.md'), 'utf8')).toBe('# original\n');
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
  });

  // localRoot axis: poisoned path-map.json with an unnormalized host path
  // would silently land writes at a different absolute path than declared
  // (path.join normalizes '..' before cpSync sees the destination). The
  // assertSafeLocalRoot guard rejects unnormalized or non-absolute paths
  // before any filesystem mutation.
  // /tmp/trailing/ is left OUT: POSIX path.normalize preserves trailing slashes,
  // and a trailing slash is benign (not a traversal vector). The check is about
  // catching `..` and redundant-segment shenanigans that cause silent target drift.
  const evilLocalRoots = ['/tmp/x/../escape', '/tmp/./redundant', 'relative/path'];
  for (const evilRoot of evilLocalRoots) {
    it(`remapExtrasPush rejects unnormalized localRoot ${JSON.stringify(evilRoot)}`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { foo: { 'test-host': evilRoot } },
          extras: { foo: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPush('20260522-evil-root')).toThrow(NomadFatal);
    });

    it(`remapExtrasPull rejects unnormalized localRoot ${JSON.stringify(evilRoot)}`, async () => {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { foo: { 'test-host': evilRoot } },
          extras: { foo: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPull } = await import('./extras-sync.ts');
      const { NomadFatal } = await import('./utils.ts');
      expect(() => remapExtrasPull('20260522-evil-root')).toThrow(NomadFatal);
    });
  }

  it('divergenceCheckExtras WARN interpolates the real ts into the backup path', async () => {
    // The WARN message must point users at the actual ~/.cache/.../<ts>/extras/
    // dir that the next remapExtrasPull will write to, not a literal `<ts>`
    // placeholder. Set up content that differs between local and shared so
    // listDivergingFiles fires the WARN branch.
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# local\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-real-ts');
    const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    // ts substring present in backup path; no un-interpolated placeholder.
    expect(warned).toContain('20260522-real-ts');
    expect(warned).not.toContain('<ts>');
  });

  it('listDivergingFiles WARNs (not silently empty) when git is not on PATH (ENOENT)', async () => {
    // Defeats D-08 if a missing git binary collapses to "no diff". Mock
    // execFileSync to throw ENOENT and confirm the WARN line fires.
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# local\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    }));
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-enoent-ts');
    const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warned).toContain('git not on PATH');
    vi.doUnmock('node:child_process');
  });

  it('listDivergingFiles WARNs (not silently empty) on unexpected git failures', async () => {
    // Symmetric to the ENOENT test: a git invocation that fails with neither
    // status === 1 (real diff) nor `ENOENT` (missing binary) must still
    // emit a WARN so D-08's loud-doctor contract holds. Without this branch
    // an unexpected git failure (e.g., status 128 from a corrupted repo
    // state) would collapse to a silent empty list and the operator would
    // not know the divergence check skipped.
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# local\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        const err = new Error('git: unexpected boom') as NodeJS.ErrnoException & {
          status?: number;
        };
        err.status = 128; // status != 1 AND code !== 'ENOENT': fall-through branch.
        throw err;
      }),
    }));
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-git-fail-ts');
    const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warned).toContain('divergence check failed');
    expect(warned).toContain('git: unexpected boom');
    vi.doUnmock('node:child_process');
  });

  it('safe logical names pass: ha-acwd, foo_bar, project.name, A1', async () => {
    // Smoke-check that the regex isn't accidentally too strict; a real-world
    // mix of valid names must all be accepted by push (it'll then short-circuit
    // on the missing extras-source path with skipped count).
    const safe = ['ha-acwd', 'foo_bar', 'project.name', 'A1'];
    for (const okKey of safe) {
      writeFileSync(
        mapPath,
        JSON.stringify({
          projects: { [okKey]: { 'test-host': projectRoot } },
          extras: { [okKey]: ['.planning'] },
        }) + '\n',
      );
      const { remapExtrasPush } = await import('./extras-sync.ts');
      const r = remapExtrasPush(`20260522-safe-${okKey}`);
      expect(r.unmapped).toBe(0);
      expect(r.skipped).toBe(0);
      vi.resetModules();
    }
  });
});

describe('whitelistedExtrasPaths', () => {
  it('returns [] when the map declares no extras field', async () => {
    const { whitelistedExtrasPaths } = await import('./extras-sync.ts');
    expect(whitelistedExtrasPaths({ projects: {} })).toEqual([]);
  });

  it('skips dirnames outside SUPPORTED_EXTRAS and returns the sorted whitelisted set', async () => {
    const { whitelistedExtrasPaths } = await import('./extras-sync.ts');
    const out = whitelistedExtrasPaths({
      projects: {},
      extras: { beta: ['.planning'], alpha: ['.planning', 'secrets'] },
    });
    // `secrets` is not in SUPPORTED_EXTRAS so it is skipped; results sorted.
    expect(out).toEqual(['shared/extras/alpha/.planning', 'shared/extras/beta/.planning']);
  });
});
