import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubPlatform } from './test-helpers.platform.ts';

// Posix-only assertions throughout this file assume the process is genuinely
// running on a non-win32 host. On a real win32 runner, syncSharedLinksPush/
// stageLocalSharedEdits take the copy-sync branch for real (process.platform
// is not mocked in these cases), so the posix-only assertions are skipped
// there; the win32 behavior itself is covered separately by the describe
// blocks that explicitly override process.platform.
const isWin = process.platform === 'win32';

describe('syncSharedLinksPush (win32 push mirror)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-push-mirror-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('mirrors a local file edit and a local directory edit into shared/ on win32', async () => {
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# local edit\n');
    expect(readFileSync(join(sharedDir, 'commands', 'foo.md'), 'utf8')).toBe('# local command\n');
  });

  it('skips a name whose local entry is still a live symlink (symlink-era guard)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    symlinkSync(join(sharedDir, 'CLAUDE.md'), join(claudeDir, 'CLAUDE.md'));

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    // The mirror must not rm the shared target out from under the symlink
    // source: shared/CLAUDE.md still exists with its original content, and
    // the local entry is still a symlink (migration is applySharedLinks's job
    // on the next pull, not this push mirror's).
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
    expect(lstatSync(join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('excludes a nested ALWAYS_NEVER_SYNC entry from the mirrored directory', async () => {
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');
    writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{"secret":true}');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(existsSync(join(sharedDir, 'commands', 'foo.md'))).toBe(true);
    expect(existsSync(join(sharedDir, 'commands', 'settings.local.json'))).toBe(false);
  });

  it('skips a name absent from ~/.claude/ without throwing', async () => {
    // No CLAUDE.md, commands, or rules under claudeDir at all.
    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    expect(() => syncSharedLinksPush({ projects: {} })).not.toThrow();
    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
  });

  it('is a no-op when path-map.json is absent (map is null)', async () => {
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    expect(() => syncSharedLinksPush(null)).not.toThrow();
    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
  });

  it.skipIf(isWin)('is a no-op on a non-win32 stub', async () => {
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });
    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
  });
});

// The pull-side mirror runs the same loop under a deliberately narrower policy
// than the push side: it never creates a shared name the repo does not already
// carry, it overlays rather than replaces, and it snapshots the repo-side copy
// first. Each of those three is a separate data-loss or accidental-publish
// path if it regresses, so each gets its own assertion here.
describe('stageLocalSharedEdits (win32 pre-pull mirror)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;
  const TS = '20260731-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-pull-mirror-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO over the $HOME fallback these fixtures
    // assume; see the matching note in commands.pull.test.ts.
    delete process.env.NOMAD_REPO;
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    stubPlatform(realPlatform);
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('stages a host edit into a shared name the repo already carries', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# unpublished local edit\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# unpublished local edit\n');
  });

  it('leaves a purely host-local name alone instead of adopting it into the repo', async () => {
    // No shared/rules in the repo: this name is private to the host. Creating
    // it here would make a plain pull a publish trigger (under `nomad sync` the
    // push half would ship it to every other host).
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'private.md'), '# host-only\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(existsSync(join(sharedDir, 'rules'))).toBe(false);
  });

  it('snapshots the repo-side copy under backup/<ts>/repo/ before overwriting it', async () => {
    // An uncommitted working-tree edit under shared/ cannot be recovered by
    // git, so the backup is the only recovery path.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# uncommitted repo-side edit\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host copy wins\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    const backedUp = join(testHome, '.cache', 'claude-nomad', 'backup', TS, 'repo', 'shared');
    expect(readFileSync(join(backedUp, 'CLAUDE.md'), 'utf8')).toBe(
      '# uncommitted repo-side edit\n',
    );
  });

  it('overlays rather than replaces, so a repo-only file the host lacks survives', async () => {
    // The host copy is missing upstream.md (an interrupted first pull, a user
    // tidy-up, an antivirus quarantine). A true mirror would rm it here and the
    // autostash would carry the deletion through the rebase.
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'upstream.md'), '# from another host\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'mine.md'), '# local\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(readFileSync(join(sharedDir, 'commands', 'upstream.md'), 'utf8')).toBe(
      '# from another host\n',
    );
    expect(readFileSync(join(sharedDir, 'commands', 'mine.md'), 'utf8')).toBe('# local\n');
  });

  it.skipIf(isWin)('is a no-op on a non-win32 stub', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
  });

  it('omitting opts.linkNames derives allSharedLinks(map) internally, WARNing once for an invalid entry', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {}, sharedDirs: ['../escape'] }, TS);
    const rejectionCalls = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sharedDirs entry'),
    );
    expect(rejectionCalls).toHaveLength(1);
  });

  it('a supplied opts.linkNames is used verbatim, bypassing allSharedLinks(map) entirely', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    mkdirSync(join(sharedDir, 'gsd'), { recursive: true });
    mkdirSync(join(claudeDir, 'gsd'), { recursive: true });
    writeFileSync(join(claudeDir, 'gsd', 'local.md'), '# local gsd\n');
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    // The map's own (invalid) sharedDirs entry is never consulted: only the
    // caller-supplied linkNames list drives which names get mirrored.
    stageLocalSharedEdits({ projects: {}, sharedDirs: ['../escape'] }, TS, {
      linkNames: ['gsd'],
    });
    expect(errSpy).not.toHaveBeenCalled();
    // CLAUDE.md is a normal SHARED_LINKS static entry but is NOT in the
    // supplied linkNames list, so it must be left untouched.
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
    // gsd IS in the supplied list, so its host edit is mirrored in.
    expect(readFileSync(join(sharedDir, 'gsd', 'local.md'), 'utf8')).toBe('# local gsd\n');
  });
});
