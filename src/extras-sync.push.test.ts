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

  it('backs up prior shared/extras content to .../backup/<ts>/repo/ before copy', async () => {
    // Overlay push: old.md is repo-only (no local counterpart). The backup
    // still snapshots the dst before the copy; but the overlay leaves old.md
    // alive in the repo (no rmSync) while new.md is written from the local src.
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

    // Overlay copy: old.md survives in the repo (repo-only files are preserved).
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'old.md'))).toBe(true);
    expect(readFileSync(join(sharedExtras, 'foo', '.planning', 'new.md'), 'utf8')).toBe('new\n');
  });

  it('.planning push overlay: a repo-only file (absent locally) survives the push (TDD acceptance 3)', async () => {
    // Seed a repo-side file with NO local counterpart. The overlay must leave
    // it untouched. This is the primary TDD acceptance criterion for plan 03.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'repo-only.md'), 'repo content\n');
    // Local .planning exists but does NOT contain repo-only.md.
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'local.md'), 'local\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    remapExtrasPush('20260522-tdd3-survive');

    // repo-only.md must still exist in the repo after the push.
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'repo-only.md'))).toBe(true);
    expect(readFileSync(join(sharedExtras, 'foo', '.planning', 'repo-only.md'), 'utf8')).toBe(
      'repo content\n',
    );
    // The local file was also copied into the repo (overlay overwrite).
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'local.md'))).toBe(true);
  });

  it('.planning push overlay: a local edit is copied into the repo (overlay overwrite preserved)', async () => {
    // A file exists in both local and repo with different content. After push,
    // the repo should have the local version (overlay overwrites existing entries).
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'old repo version\n');
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), 'new local version\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    remapExtrasPush('20260522-tdd3-overwrite');

    // The local edit overwrote the repo file.
    expect(readFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), 'utf8')).toBe(
      'new local version\n',
    );
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

  it('.claude extra: filters NEVER_SYNC host-local state, copies config; pushed contains foo/.claude', async () => {
    // Integration test: remapExtrasPush must filter the .claude extra against
    // the full NEVER_SYNC boundary so host-local secrets AND ephemeral state
    // (shell-snapshots, sessions) never reach the repo, while config does.
    const claudeDir = join(projectRoot, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), '{"model":"claude-opus-4-5"}\n');
    writeFileSync(join(claudeDir, 'settings.local.json'), 'secret=localonly\n');
    mkdirSync(join(claudeDir, 'shell-snapshots'), { recursive: true });
    writeFileSync(join(claudeDir, 'shell-snapshots', 'snap.sh'), 'export TOKEN=abc\n');
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'sessions', 's.json'), '{}\n');
    mkdirSync(join(claudeDir, 'projects', 'enc'), { recursive: true });
    writeFileSync(join(claudeDir, 'projects', 'enc', 'transcript.jsonl'), '{"secret":1}\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.claude'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    const result = remapExtrasPush('20260522-110007');

    // settings.local.json (ALWAYS_NEVER_SYNC) must NOT be staged.
    expect(existsSync(join(sharedExtras, 'foo', '.claude', 'settings.local.json'))).toBe(false);
    // NEVER_SYNC-only ephemeral state must NOT be staged (the CR-01 fix).
    expect(existsSync(join(sharedExtras, 'foo', '.claude', 'shell-snapshots'))).toBe(false);
    expect(existsSync(join(sharedExtras, 'foo', '.claude', 'sessions'))).toBe(false);
    // projects/ (transcripts) must NOT be staged: in CLAUDE_EXTRA_NEVER_SYNC.
    expect(existsSync(join(sharedExtras, 'foo', '.claude', 'projects'))).toBe(false);
    // settings.json (config) must be present.
    expect(existsSync(join(sharedExtras, 'foo', '.claude', 'settings.json'))).toBe(true);
    expect(readFileSync(join(sharedExtras, 'foo', '.claude', 'settings.json'), 'utf8')).toBe(
      '{"model":"claude-opus-4-5"}\n',
    );
    // pushed must report the item.
    expect(result).toEqual({
      unmapped: 0,
      skipped: 0,
      pushed: ['foo/.claude'],
      wouldPush: [],
    });
  });

  it('.planning push: ALWAYS_NEVER_SYNC files are NOT copied into the repo working tree (WR-02 regression)', async () => {
    // A secret file with an ALWAYS_NEVER_SYNC basename in .planning must never
    // reach the repo working tree on push, even before the allow-list gate.
    // The filtered overlay strips it at the copy layer so no residue accumulates.
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(planningDir, { recursive: true });
    writeFileSync(join(planningDir, 'PLAN.md'), '# plan\n');
    writeFileSync(join(planningDir, '.credentials.json'), '{"secret":"keep-off-repo"}\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    remapExtrasPush('20260522-wr02-filter');

    // Normal file was pushed.
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'))).toBe(true);
    // ALWAYS_NEVER_SYNC file must NOT be in the repo working tree.
    expect(existsSync(join(sharedExtras, 'foo', '.planning', '.credentials.json'))).toBe(false);
  });

  it('.planning extra: keeps todos/ on push (NEVER_SYNC widening must not leak onto .planning)', async () => {
    // Regression guard for the per-extra denylist: .planning keeps the narrow
    // ALWAYS_NEVER_SYNC subset, so its legitimate todos/ GSD content still syncs.
    const planningDir = join(projectRoot, '.planning');
    mkdirSync(join(planningDir, 'todos'), { recursive: true });
    writeFileSync(join(planningDir, 'todos', 'task.md'), '# task\n');
    writeFileSync(join(planningDir, 'PLAN.md'), '# plan\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPush } = await import('./extras-sync.ts');
    remapExtrasPush('20260522-110008');

    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'todos', 'task.md'))).toBe(true);
    expect(existsSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'))).toBe(true);
  });
});
