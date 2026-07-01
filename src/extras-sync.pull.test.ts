import { execFileSync } from 'node:child_process';
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

  it('.claude extra: filters a blocked file on pull (poisoned-repo defense-in-depth)', async () => {
    // Pull filters `.claude` against its NEVER_SYNC boundary so a repo that
    // somehow contains a per-host file does not restore it onto the host. The
    // copy itself never reaches the gate, so this exercises the pull-side
    // filtered branch directly.
    mkdirSync(join(sharedExtras, 'foo', '.claude'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.claude', 'settings.json'), '{"model":"x"}\n');
    writeFileSync(join(sharedExtras, 'foo', '.claude', 'settings.local.json'), 'secret=1\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.claude'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120010');

    // Config is restored; the blocked per-host file is not.
    expect(existsSync(join(projectRoot, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(projectRoot, '.claude', 'settings.local.json'))).toBe(false);
    expect(result.pulled).toEqual(['foo/.claude']);
  });

  it('.planning extra: filters ALWAYS_NEVER_SYNC files on pull (poisoned-repo defense-in-depth)', async () => {
    // Pull filters `.planning` against ALWAYS_NEVER_SYNC so a repo that
    // contains e.g. .credentials.json does not restore it onto the host.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      join(sharedExtras, 'foo', '.planning', '.credentials.json'),
      '{"secret":"poisoned"}\n',
    );
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120011');

    // Normal content is restored; the blocked ALWAYS_NEVER_SYNC file is not.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
    expect(existsSync(join(projectRoot, '.planning', '.credentials.json'))).toBe(false);
    expect(result.pulled).toEqual(['foo/.planning']);
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
    // ... but the per-skip narration was removed (skips are silent, counted
    // only), so no SUPPORTED_EXTRAS skip line reaches the console.
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

    // Overlay: old.md survives (no delete pass without prePostHeads); new.md is added.
    expect(existsSync(join(projectRoot, '.planning', 'old.md'))).toBe(true);
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

  it('Test H (bug regression): host-local settings.local.json survives a .claude pull', async () => {
    // Core regression: push filtered settings.local.json out of the repo, so src
    // only has settings.json. Before the fix, the blanket rmSync wiped the host's
    // settings.local.json and nothing restored it. After the fix it must survive.
    mkdirSync(join(sharedExtras, 'foo', '.claude'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.claude', 'settings.json'), '{"model":"opus"}\n');
    // settings.local.json intentionally absent from src (as push would produce).
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'settings.local.json'), 'apiKey=local\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.claude'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260608-h');

    // Host-local file must survive.
    expect(existsSync(join(projectRoot, '.claude', 'settings.local.json'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.claude', 'settings.local.json'), 'utf8')).toBe(
      'apiKey=local\n',
    );
    // Repo file must be restored.
    expect(existsSync(join(projectRoot, '.claude', 'settings.json'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"model":"opus"}\n',
    );
    expect(result.pulled).toEqual(['foo/.claude']);
  });

  it('Test I (true mirror still prunes synced files): stale non-deny .claude file absent from src is removed', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.claude'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.claude', 'settings.json'), '{"model":"opus"}\n');
    // stale.json was once synced but is now absent from the repo.
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'stale.json'), 'old=1\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.claude'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260608-i');

    // Synced (non-deny) file absent from src is pruned.
    expect(existsSync(join(projectRoot, '.claude', 'stale.json'))).toBe(false);
    // Repo file is present.
    expect(existsSync(join(projectRoot, '.claude', 'settings.json'))).toBe(true);
  });

  it('Test J (routing: .planning uses overlay semantics): a local-only .planning file absent from src survives', async () => {
    // Confirm the .planning branch uses copyExtrasOverlay (not copyExtras).
    // A file present only in dst/.planning and absent from src/.planning is
    // preserved by the overlay; without prePostHeads there is no delete pass.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'local-only.md'), 'local work\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260608-j');

    // Overlay: local-only.md absent from src is preserved (no delete pass without prePostHeads).
    expect(existsSync(join(projectRoot, '.planning', 'local-only.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.planning', 'local-only.md'), 'utf8')).toBe(
      'local work\n',
    );
    // Repo file is also present.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
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

  it('keeps a locally-edited <localRoot>/CLAUDE.md on pull and still backs it up', async () => {
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

    // The local edit diverges from the repo copy, so it wins on conflict: the
    // pull keeps the local file rather than clobbering it with the repo version.
    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe('# original rules\n');
  });

  it('overwrites a byte-equal <localRoot>/CLAUDE.md on pull (no divergence)', async () => {
    // When the local file already matches the repo copy there is no conflict, so
    // the copy proceeds (a harmless identical write) and the file is recorded.
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# same rules\n');
    mkdirSync(join(sharedExtras, 'foo'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# same rules\n');
    writeFileSync(
      mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['CLAUDE.md'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260522-120009');

    expect(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe('# same rules\n');
    expect(result.pulled).toEqual(['foo/CLAUDE.md']);
  });
});

// ---------------------------------------------------------------------------
// TDD acceptance tests: overlay + delete-propagation via prePostHeads
// ---------------------------------------------------------------------------

/**
 * Helper: run a git command with explicit cwd; throws on non-zero exit.
 *
 * @param args Git arguments.
 * @param cwd Working directory.
 */
function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Helper: capture trimmed stdout of a git command.
 *
 * @param args Git arguments.
 * @param cwd Working directory.
 * @returns Trimmed stdout string.
 */
function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

describe('remapExtrasPull: prePostHeads delete-propagation (TDD acceptance)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoDir: string;
  let sharedExtras: string;
  let projectRoot: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-pull-heads-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoDir = join(testHome, 'claude-nomad');
    process.env.NOMAD_REPO = repoDir;
    sharedExtras = join(repoDir, 'shared', 'extras');
    projectRoot = join(testHome, 'fake-project');
    mkdirSync(sharedExtras, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    // Initialise a real git repo in repoDir so rev-parse and git diff work.
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.invalid'], repoDir);
    git(['config', 'user.name', 'test'], repoDir);
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

  it('TDD-1: local-only .planning file absent from repo survives remapExtrasPull', async () => {
    // A file git never tracked is in neither the diff nor the repo tree.
    // Even with prePostHeads provided (empty diff), it must survive.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    // Commit one file so pre-rebase HEAD is valid.
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'base'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);
    const post = pre; // no change; diff is empty

    // Seed a local-only file not tracked by git.
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'local-only.md'), 'my local work\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-tdd1', { prePostHeads: { pre, post } });

    expect(existsSync(join(projectRoot, '.planning', 'local-only.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.planning', 'local-only.md'), 'utf8')).toBe(
      'my local work\n',
    );
    // Repo file also copied.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('TDD-2: upstream-deleted .planning file IS removed locally via prePostHeads diff', async () => {
    // Commit a .planning file (pre state), then git rm + commit it (post state).
    // remapExtrasPull with { pre, post } must remove the file from localRoot.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'DELETE-ME.md'), 'will be deleted\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add planning files'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Simulate upstream deletion: git rm + commit.
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'DELETE-ME.md')], repoDir);
    // Also remove the file from disk (git rm did that).
    git(['commit', '-q', '-m', 'delete DELETE-ME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Seed the local .planning directory with the file (it was there before pull).
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'will be deleted\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    // Restore the file in shared/extras for the overlay copy (post-rebase state).
    // In a real pull the src is the post-rebase repo; here we must ensure the
    // overlay src only has PLAN.md (DELETE-ME.md was git-rm'd).
    // The repo disk already removed DELETE-ME.md via git rm; src is correct.
    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-tdd2', { prePostHeads: { pre, post } });

    // TDD acceptance 2: upstream-deleted file is removed from localRoot.
    expect(existsSync(join(projectRoot, '.planning', 'DELETE-ME.md'))).toBe(false);
    // Non-deleted file survives.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('keeps a locally-edited .planning file that was deleted upstream and WARNs', async () => {
    // Delete-vs-edit conflict: the file was removed upstream but the host edited
    // it locally since the last sync, so the delete is skipped and the local
    // copy is kept (symmetric with the modify-path guard).
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'DELETE-ME.md'), 'pre-sync content\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add planning files'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'DELETE-ME.md')], repoDir);
    git(['commit', '-q', '-m', 'delete DELETE-ME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Local copy diverges from the pre-rebase repo blob (locally edited).
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'my local edits\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-keep-edit', { prePostHeads: { pre, post } });

    // The locally-edited file survives with its local content.
    expect(existsSync(join(projectRoot, '.planning', 'DELETE-ME.md'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'utf8')).toBe(
      'my local edits\n',
    );
    // A WARN was emitted naming the kept file.
    const output = writes.join('\n');
    expect(output).toContain('DELETE-ME.md');
    expect(output).toContain('keeping locally-edited');
  });

  it('keeps an upstream-deleted path whose local copy is unreadable (type changed to a dir)', async () => {
    // Fail-safe: the local read throws (the path became a directory), so the
    // ambiguous compare is treated as diverged and the delete is skipped rather
    // than aborting the pull. The local content is kept.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'DELETE-ME.md'), 'pre-sync content\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add planning files'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'DELETE-ME.md')], repoDir);
    git(['commit', '-q', '-m', 'delete DELETE-ME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Locally, DELETE-ME.md is a directory, so reading it as a file throws.
    mkdirSync(join(projectRoot, '.planning', 'DELETE-ME.md'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md', 'nested.md'), 'local work\n');
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-keep-unreadable', { prePostHeads: { pre, post } });

    // The local directory (and its content) survives the delete pass.
    expect(existsSync(join(projectRoot, '.planning', 'DELETE-ME.md', 'nested.md'))).toBe(true);
  });

  it('TDD-3: first-ever pull (no prePostHeads) overlays only and deletes nothing', async () => {
    // Without prePostHeads the delete pass is skipped entirely.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'local-only.md'), 'never tracked\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    // No prePostHeads: first-ever pull / no pre-state.
    remapExtrasPull('20260611-tdd3');

    // Local-only file survives (no delete pass).
    expect(existsSync(join(projectRoot, '.planning', 'local-only.md'))).toBe(true);
    // Repo file copied.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('TDD-4: dryRun skips overlay and delete pass (zero-mutation contract)', async () => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const result = remapExtrasPull('20260611-tdd4', {
      dryRun: true,
      prePostHeads: { pre: 'abc', post: 'def' },
    });

    // dryRun: nothing written to localRoot, would-list populated.
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
    expect(result.wouldPull).toContain('foo/.planning');
    expect(result.pulled).toHaveLength(0);
  });

  it('TDD-5: non-.planning extras in the delete-pass loop are skipped (branch coverage)', async () => {
    // When a project has both .planning and CLAUDE.md extras, the delete-pass
    // loop skips CLAUDE.md (dirname !== .planning) and only processes .planning.
    // This covers the `if (t.dirname !== '.planning') continue` branch.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'DELETE-ME.md'), 'gone\n');
    mkdirSync(join(sharedExtras, 'foo'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# rules\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'initial'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Delete DELETE-ME.md upstream.
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'DELETE-ME.md')], repoDir);
    git(['commit', '-q', '-m', 'delete DELETE-ME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Seed both extras locally.
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'gone\n');
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# original rules\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning', 'CLAUDE.md'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-tdd5', { prePostHeads: { pre, post } });

    // DELETE-ME.md removed by the .planning delete pass.
    expect(existsSync(join(projectRoot, '.planning', 'DELETE-ME.md'))).toBe(false);
    // PLAN.md and CLAUDE.md survive.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
    expect(existsSync(join(projectRoot, 'CLAUDE.md'))).toBe(true);
  });

  it('IN-01: empty parent directory is pruned after its only file is deleted upstream', async () => {
    // When a file in a sub-directory is deleted upstream, pruneEmptyAncestors
    // should remove the now-empty parent up to the planning root. An anchor
    // file at the .planning root level keeps the planning dir (and shared/extras/)
    // alive after the git rm so requireRepoExtras still passes.
    mkdirSync(join(sharedExtras, 'foo', '.planning', 'sub'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'sub', 'FILE.md'), '# file\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add sub/FILE.md'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'sub', 'FILE.md')], repoDir);
    git(['commit', '-q', '-m', 'delete sub/FILE.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    mkdirSync(join(projectRoot, '.planning', 'sub'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'sub', 'FILE.md'), '# file\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-in01', { prePostHeads: { pre, post } });

    // File deleted.
    expect(existsSync(join(projectRoot, '.planning', 'sub', 'FILE.md'))).toBe(false);
    // Empty parent sub/ directory also pruned.
    expect(existsSync(join(projectRoot, '.planning', 'sub'))).toBe(false);
    // Planning root and its anchor file survive.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('CR-02 regression: backup exists before delete even when overlay src is absent (whole .planning removed upstream)', async () => {
    // Commit a .planning file plus an anchor file in shared/extras/ root (so
    // git rm of .planning does not make shared/extras/ itself disappear). Then
    // remove the entire .planning dir from the repo. The src for the .planning
    // extra is gone, so the overlay loop skips backup+copy. The delete pass
    // must still snapshot localRoot/.planning before removing files.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    // Anchor: a file at shared/extras/foo/ level keeps shared/extras/foo/ alive
    // after git rm of .planning/ so requireRepoExtras still passes.
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# rules\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add planning'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Remove the entire .planning directory upstream.
    git(['rm', '-q', '-r', join('shared', 'extras', 'foo', '.planning')], repoDir);
    git(['commit', '-q', '-m', 'remove .planning dir'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Seed local .planning with the file, byte-equal to the pre-rebase repo
    // copy so the delete-vs-edit guard treats it as unmodified and deletes it.
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const ts = 'cr02-backup-test';
    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull(ts, { prePostHeads: { pre, post } });

    // The file was deleted from localRoot.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(false);

    // A backup was taken before the delete.
    const { encodePath } = await import('./utils.json.ts');
    const backupDir = join(testHome, '.cache', 'claude-nomad', 'backup', ts, 'extras');
    const encoded = encodePath(projectRoot);
    const backupFile = join(backupDir, encoded, '.planning', 'PLAN.md');
    expect(existsSync(backupFile)).toBe(true);
  });

  it('pruneEmptyAncestors stops at a non-empty ancestor dir (line 95 branch)', async () => {
    // Two files in the same sub-dir: upstream deletes one, the sibling stays.
    // After the delete, the parent sub/ dir is non-empty (sibling still present),
    // so pruneEmptyAncestors must stop and leave sub/ intact.
    mkdirSync(join(sharedExtras, 'foo', '.planning', 'sub'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'sub', 'FILE-A.md'), 'A\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'sub', 'FILE-B.md'), 'B\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add two files in sub'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Delete only FILE-A.md upstream; FILE-B.md remains.
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'sub', 'FILE-A.md')], repoDir);
    git(['commit', '-q', '-m', 'delete FILE-A.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    mkdirSync(join(projectRoot, '.planning', 'sub'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'sub', 'FILE-A.md'), 'A\n');
    writeFileSync(join(projectRoot, '.planning', 'sub', 'FILE-B.md'), 'B\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-prune-stop', { prePostHeads: { pre, post } });

    // FILE-A.md is deleted (upstream D record).
    expect(existsSync(join(projectRoot, '.planning', 'sub', 'FILE-A.md'))).toBe(false);
    // sub/ dir is NOT pruned because FILE-B.md still occupies it.
    expect(existsSync(join(projectRoot, '.planning', 'sub'))).toBe(true);
    // Sibling survives.
    expect(existsSync(join(projectRoot, '.planning', 'sub', 'FILE-B.md'))).toBe(true);
  });

  it('WR-04: delete is skipped when the repo counterpart still exists (case-rename simulation)', async () => {
    // Simulate a case-only rename on a case-insensitive filesystem: git diff
    // shows the old lowercase name as D, but the file on disk in shared/extras/
    // still exists (the new cased name resolves to it). The local file must NOT
    // be deleted.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'RENAME.md'), 'content\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'initial'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Record RENAME.md as D (simulates old-name half of a case-rename diff).
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'RENAME.md')], repoDir);
    git(['commit', '-q', '-m', 'git rm RENAME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Manually restore RENAME.md in shared/extras/ on disk (simulating a
    // case-insensitive FS where the new-cased file resolves to the same path).
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'RENAME.md'), 'content\n');

    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, '.planning', 'RENAME.md'), 'content\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    remapExtrasPull('20260611-wr04', { prePostHeads: { pre, post } });

    // The repo counterpart exists on disk, so the local file must survive.
    expect(existsSync(join(projectRoot, '.planning', 'RENAME.md'))).toBe(true);
  });

  it('delete-pass is a no-op when the target parent dir is already gone (line 156 branch)', async () => {
    // Two sibling files in sub/ are both D records. The first delete (FILE-A.md)
    // also triggers pruneEmptyAncestors which removes sub/. When the second
    // target (FILE-B.md) reaches deletePlanningTarget, its parent (sub/) is
    // already gone so tryRealpath(dirname(target)) returns undefined and the
    // function returns early without crashing.
    mkdirSync(join(sharedExtras, 'foo', '.planning', 'sub'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# anchor\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'sub', 'FILE-A.md'), 'A\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'sub', 'FILE-B.md'), 'B\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add files'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Delete both files in the same commit so the diff has two D records.
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'sub', 'FILE-A.md')], repoDir);
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'sub', 'FILE-B.md')], repoDir);
    git(['commit', '-q', '-m', 'delete both files'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    mkdirSync(join(projectRoot, '.planning', 'sub'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# anchor\n');
    writeFileSync(join(projectRoot, '.planning', 'sub', 'FILE-A.md'), 'A\n');
    writeFileSync(join(projectRoot, '.planning', 'sub', 'FILE-B.md'), 'B\n');
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    // Must not throw even though the second target's parent dir is already gone.
    expect(() =>
      remapExtrasPull('20260611-parent-gone', { prePostHeads: { pre, post } }),
    ).not.toThrow();

    // Both files gone; sub/ dir also gone (pruned by first delete).
    expect(existsSync(join(projectRoot, '.planning', 'sub'))).toBe(false);
    // Anchor file at root level survives.
    expect(existsSync(join(projectRoot, '.planning', 'PLAN.md'))).toBe(true);
  });

  it('delete-pass is a no-op when the planning root itself is missing (line 158 branch)', async () => {
    // Simulate a D record that targets a file under .planning, but the local
    // .planning directory was already removed before the delete pass runs (e.g.
    // a previous delete + prune cleared it entirely). tryRealpath(planningRoot)
    // returns undefined and the function returns early without crashing.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'FILE.md'), 'content\n');
    // Anchor at extras/foo/ level so shared/extras/ survives the git rm.
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# rules\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'initial'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'FILE.md')], repoDir);
    git(['commit', '-q', '-m', 'delete FILE.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    // Do NOT create localRoot/.planning at all; the planning root is missing.
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    // Must not throw even though .planning does not exist locally.
    expect(() =>
      remapExtrasPull('20260611-root-gone', { prePostHeads: { pre, post } }),
    ).not.toThrow();

    // .planning was never created (no overlay src and early-exit on delete).
    expect(existsSync(join(projectRoot, '.planning'))).toBe(false);
  });

  it('WR-03: delete is skipped when an intermediate symlink would escape the planning root (line 159 branch)', async () => {
    // Seed a symlink inside .planning/ that points to a directory outside the
    // project root. A D record targeting a file "inside" that symlinked dir
    // must not delete the outside file -- the symlink-escape guard fires.
    //
    // Setup note: the entire .planning dir is removed from shared/extras/ on
    // disk after the git commits so the overlay copy pass skips the backup for
    // this target (existsSync(src) == false). That avoids a double cpSync call
    // with force:false on a symlink-to-outside-dir, which Node.js rejects on
    // the second call. Only the delete-pass snapshot runs once (safe).
    const outsideDir = mkdtempSync(join(tmpdir(), 'wr03-outside-'));
    try {
      writeFileSync(join(outsideDir, 'secret.md'), 'outside content\n');

      // Commit a real link/secret.md so the git D record is valid, plus an
      // anchor CLAUDE.md at extras/foo/ level so shared/extras/foo/ survives
      // the full git rm of .planning/.
      mkdirSync(join(sharedExtras, 'foo', '.planning', 'link'), { recursive: true });
      writeFileSync(
        join(sharedExtras, 'foo', '.planning', 'link', 'secret.md'),
        'outside content\n',
      );
      writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# rules\n');
      git(['add', '.'], repoDir);
      git(['commit', '-q', '-m', 'initial'], repoDir);
      const pre = gitOut(['rev-parse', 'HEAD'], repoDir);

      // Delete the entire .planning dir upstream (produces D record for
      // link/secret.md). CLAUDE.md anchor keeps shared/extras/foo/ alive.
      git(['rm', '-q', '-r', join('shared', 'extras', 'foo', '.planning')], repoDir);
      git(['commit', '-q', '-m', 'delete .planning dir'], repoDir);
      const post = gitOut(['rev-parse', 'HEAD'], repoDir);
      // shared/extras/foo/.planning is gone from disk; only CLAUDE.md remains.

      // On disk: localRoot/.planning/link is a symlink to outsideDir.
      // The D target planningDeleteTargets() computes resolves to
      // localRoot/.planning/link/secret.md, but the real path of its dirname
      // (i.e. realpath(outsideDir)) is outside the planning root.
      // isInsidePlanningRoot must return false, so the delete is skipped.
      mkdirSync(join(projectRoot, '.planning'), { recursive: true });
      writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
      symlinkSync(outsideDir, join(projectRoot, '.planning', 'link'));

      writeFileSync(
        join(repoDir, 'path-map.json'),
        JSON.stringify({
          projects: { foo: { 'test-host': projectRoot } },
          extras: { foo: ['.planning'] },
        }) + '\n',
      );

      const { remapExtrasPull } = await import('./extras-sync.ts');
      remapExtrasPull('20260611-wr03', { prePostHeads: { pre, post } });

      // The outside file must survive the delete pass (symlink escape blocked).
      expect(existsSync(join(outsideDir, 'secret.md'))).toBe(true);
      // The symlink itself is still intact.
      expect(existsSync(join(projectRoot, '.planning', 'link'))).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('git diff failure during delete-propagation surfaces as NomadFatal', async () => {
    // A valid repo + committed .planning file lets the overlay copy succeed so
    // propagatePlanningDeletes reaches `git diff`. A well-formed but nonexistent
    // pre-rebase SHA makes `git diff` exit non-zero; the raw ExecException must
    // be normalized to NomadFatal rather than bubbling a stack trace.
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'base'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const { remapExtrasPull } = await import('./extras-sync.ts');
    const { NomadFatal } = await import('./utils.ts');
    const badPre = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(() =>
      remapExtrasPull('20260611-diff-fail', { prePostHeads: { pre: badPre, post } }),
    ).toThrow(NomadFatal);
  });

  /**
   * Seed the pre/post repo states for a delete-vs-edit preview: DELETE-ME.md is
   * committed (pre), then removed upstream (post); PLAN.md stays as an anchor so
   * the repo `.planning` dir survives. Writes the path-map with the given extras.
   *
   * @param localDeleteMe - Local content for DELETE-ME.md, or null to omit it.
   * @param extras - The extras array for logical `foo`.
   * @returns The pre and post HEAD SHAs.
   */
  const seedDeleteVsEdit = (
    localDeleteMe: string | null,
    extras: string[] = ['.planning'],
  ): { pre: string; post: string } => {
    mkdirSync(join(sharedExtras, 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(sharedExtras, 'foo', '.planning', 'DELETE-ME.md'), 'pre-sync content\n');
    writeFileSync(join(sharedExtras, 'foo', 'CLAUDE.md'), '# rules\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'add planning files'], repoDir);
    const pre = gitOut(['rev-parse', 'HEAD'], repoDir);
    git(['rm', '-q', join('shared', 'extras', 'foo', '.planning', 'DELETE-ME.md')], repoDir);
    git(['commit', '-q', '-m', 'delete DELETE-ME.md'], repoDir);
    const post = gitOut(['rev-parse', 'HEAD'], repoDir);

    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'PLAN.md'), '# plan\n');
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# rules\n');
    if (localDeleteMe !== null) {
      writeFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), localDeleteMe);
    }
    writeFileSync(
      join(repoDir, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: extras },
      }) + '\n',
    );
    return { pre, post };
  };

  it('divergenceCheckExtras with prePostHeads previews a delete-vs-edit keep-local WARN', async () => {
    const { pre, post } = seedDeleteVsEdit('my local edits\n');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260611-preview-keep', { pre, post });

    const output = writes.join('\n');
    expect(output).toContain('keeping locally-edited');
    expect(output).toContain('DELETE-ME.md');
    // Read-only: the local file is untouched by the preview.
    expect(readFileSync(join(projectRoot, '.planning', 'DELETE-ME.md'), 'utf8')).toBe(
      'my local edits\n',
    );
  });

  it('divergenceCheckExtras preview stays silent when the upstream-deleted file is unmodified', async () => {
    // Local bytes equal the pre-rebase blob, so it is not a conflict: the real
    // pull would delete it, and the preview must not claim a keep-local.
    const { pre, post } = seedDeleteVsEdit('pre-sync content\n');
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260611-preview-nokeep', { pre, post });

    expect(writes.join('\n')).not.toContain('keeping locally-edited');
  });

  it('divergenceCheckExtras preview skips non-.planning extras targets', async () => {
    // CLAUDE.md leads the extras array so the preview loop hits (and skips) a
    // non-.planning target before reaching the .planning delete detection.
    const { pre, post } = seedDeleteVsEdit('my local edits\n', ['CLAUDE.md', '.planning']);
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    divergenceCheckExtras('20260611-preview-skip', { pre, post });

    // The .planning delete-vs-edit WARN still fires despite the leading CLAUDE.md.
    expect(writes.join('\n')).toContain('keeping locally-edited');
  });

  it('divergenceCheckExtras preview is tolerant of a git failure (no WARN, no throw)', async () => {
    // A nonexistent pre SHA makes the preview diff fail; the tolerant catch
    // yields no delete-vs-edit WARN and never throws out of a read-only preview.
    const { post } = seedDeleteVsEdit('my local edits\n');
    const badPre = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const writes: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '));
    });

    const { divergenceCheckExtras } = await import('./extras-sync.ts');
    expect(() =>
      divergenceCheckExtras('20260611-preview-tolerant', { pre: badPre, post }),
    ).not.toThrow();
    expect(writes.join('\n')).not.toContain('keeping locally-edited');
  });
});
