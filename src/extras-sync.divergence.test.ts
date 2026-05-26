import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // `vi.restoreAllMocks()` does NOT clear `vi.doMock` module mocks, and the
    // inline `vi.doUnmock` at the end of a test is skipped if any assertion
    // throws first; this net prevents a leaked mock from bleeding into later
    // tests in the file.
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Capture `process.stderr.write` and `console.error` output, joined. The
   * `warn()` helper routes through `console.error`; both spies are installed
   * in case either path is exercised. Returns the joined stderr captures so
   * tests can assert against the WARN glyph and file names.
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

  it('WARNs on a diverging single root file naming CLAUDE.md and a count', async () => {
    // A diverging CLAUDE.md (file extra, not a directory) must surface the same
    // per-file WARN + count as a diverging directory entry.
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# local rules\n');
    mkdirSync(join(sharedExtras, 'foo'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# repo rules\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['CLAUDE.md'] },
      }) + '\n',
    );
    const captured = captureStderr();

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260522-test');

    const output = captured.read();
    expect(output).toContain('CLAUDE.md');
    expect(output).toMatch(/1 file/);
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
