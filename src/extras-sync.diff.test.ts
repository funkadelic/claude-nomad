import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('divergenceCheckExtras git-diff failure modes (listDivergingFiles)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let projectRoot: string;
  let mapPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-diff-fail-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    projectRoot = join(testHome, 'fake-project');
    mapPath = join(repoUnderHome, 'path-map.json');
    mkdirSync(join(repoUnderHome, 'shared', 'extras'), { recursive: true });
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), '# local\n');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Net for the doMock('node:child_process') sites below: an inline
    // doUnmock is skipped if an assertion throws first, so unmock here too.
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('divergenceCheckExtras WARN interpolates the real ts into the backup path', async () => {
    // The WARN must point at the actual ~/.cache/.../<ts>/extras/ dir the next
    // pull writes to, not a literal `<ts>` placeholder.
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
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
    expect(warned).toContain('20260522-real-ts');
    expect(warned).not.toContain('<ts>');
  });

  it('listDivergingFiles WARNs (not silently empty) when git is not on PATH (ENOENT)', async () => {
    // Defeats D-08 if a missing git binary collapses to "no diff".
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
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
    // Symmetric to ENOENT: a git failure that is neither status === 1 (real
    // diff) nor ENOENT must still WARN so D-08's loud-doctor contract holds
    // (e.g. status 128 from a corrupted repo state).
    const sharedExtras = join(repoUnderHome, 'shared', 'extras');
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'STATE.md'), '# shared\n');
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
});
