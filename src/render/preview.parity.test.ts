import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitInit, g, gitOut } from '../test-support/git.ts';

/**
 * Parity between the settings preview (`previewSettings`) and the wet write
 * (`regenerateSettings`): for the same inputs, the preview must not report a
 * refusal the wet pull would not make, and vice versa.
 */
describe('settings preview and wet pull parity', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repo: string;
  let basePath: string;
  let hostPath: string;
  let settingsPath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    delete process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-preview-parity-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repo = join(testHome, 'claude-nomad');
    mkdirSync(join(repo, 'shared'), { recursive: true });
    mkdirSync(join(repo, 'hosts'), { recursive: true });
    mkdirSync(join(testHome, '.claude'), { recursive: true });
    basePath = join(repo, 'shared', 'settings.base.json');
    hostPath = join(repo, 'hosts', 'test-host.json');
    settingsPath = join(testHome, '.claude', 'settings.json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    rmSync(testHome, { recursive: true, force: true });
  });

  it.each([
    ['an array', '[1]'],
    ['a string', '"abc"'],
    ['null', 'null'],
  ])('live settings.json holding %s: neither side refuses', async (_label, content) => {
    writeFileSync(basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(settingsPath, content);

    const { previewSettings } = await import('./preview.ts');
    const preview = previewSettings(basePath, hostPath, settingsPath);
    expect(preview).toEqual({ diff: '', notes: ['malformed; skipping diff'] });

    const { regenerateSettings } = await import('../sync/links.ts');
    const wet = regenerateSettings('20260516-000000');
    expect(wet.blocked).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'sonnet' });
  });

  it('gsd-only live hooks: neither side refuses and the wet write lands', async () => {
    writeFileSync(basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    const gsdHook = { type: 'command', command: 'node /a/hooks/gsd-check-update.js' };
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: { SessionStart: [{ matcher: '', hooks: [gsdHook] }] },
      }) + '\n',
    );

    const { previewSettings } = await import('./preview.ts');
    const preview = previewSettings(basePath, hostPath, settingsPath);
    expect(preview.notes.some((n) => n.includes('capture-settings'))).toBe(false);
    expect(preview.diff).toContain('opus');

    const { regenerateSettings } = await import('../sync/links.ts');
    expect(regenerateSettings('20260516-000000').blocked).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ model: 'sonnet' });
  });

  it('malformed host file: the preview names no refusal the wet pull cannot reach', async () => {
    writeFileSync(basePath, JSON.stringify({ model: 'sonnet' }) + '\n');
    writeFileSync(hostPath, '{ malformed json');
    const live = JSON.stringify({ model: 'sonnet', statusLine: 1 }) + '\n';
    writeFileSync(settingsPath, live);

    const { previewSettings } = await import('./preview.ts');
    expect(previewSettings(basePath, hostPath, settingsPath)).toEqual({
      diff: '',
      notes: ['malformed hosts/test-host.json; skipping diff'],
    });

    const { regenerateSettings } = await import('../sync/links.ts');
    expect(() => regenerateSettings('20260516-000000')).toThrow();
    expect(readFileSync(settingsPath, 'utf8')).toBe(live);
  });

  describe('a settings key removed by the incoming commits', () => {
    const live = { model: 'sonnet', statusLine: { type: 'command' } };
    let pre: string;
    let post: string;

    /** Commit `content` as the base file and return the new HEAD. */
    function commitBase(content: object): string {
      writeFileSync(basePath, JSON.stringify(content) + '\n');
      g(['add', '-A'], repo);
      g(['commit', '-q', '-m', 'base'], repo);
      return gitOut(['rev-parse', 'HEAD'], repo);
    }

    /** Render the dry-run preview for `heads` and return its stdout. */
    async function previewOutput(heads: { pre: string; post: string }): Promise<string> {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      const { computePreview } = await import('./preview.ts');
      computePreview('20260516-000000', { projects: {} }, 'pull', undefined, heads);
      return logs.join('\n');
    }

    beforeEach(() => {
      gitInit(repo);
      writeFileSync(join(repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
      pre = commitBase(live);
      post = commitBase({ model: 'sonnet' });
      writeFileSync(settingsPath, JSON.stringify(live) + '\n');
    });

    it('is deleted, not refused, when the pull moved HEAD past its removal', async () => {
      const out = await previewOutput({ pre, post });
      expect(out).not.toContain('capture-settings');
      expect(out).toContain('"statusLine"');

      const { regenerateSettings } = await import('../sync/links.ts');
      expect(
        regenerateSettings('20260516-000000', { prePostHeads: { pre, post } }).blocked,
      ).toEqual([]);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'sonnet' });
    });

    it.each([
      ['HEAD did not move', () => ({ pre: post, post })],
      ['git cannot read the pre commit', () => ({ pre: 'f'.repeat(40), post })],
    ])('is refused on both sides when %s', async (_label, heads) => {
      const out = await previewOutput(heads());
      expect(out).toContain('capture-settings');

      const { regenerateSettings } = await import('../sync/links.ts');
      expect(regenerateSettings('20260516-000000', { prePostHeads: heads() }).blocked).toEqual([
        'statusLine',
      ]);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(live);
    });
  });
});
