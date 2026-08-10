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

/**
 * Enumerates the four `dryRun` x `onPreview` combinations `mirrorOneSharedName`
 * gained, plus the platform gate and the null-map gate. Codecov patch runs at
 * 100% over the diff, so a single untested defensive branch on a changed line
 * fails it; this block exists to pin each branch directly rather than relying
 * on cross-file coverage from `commands.pull.win32.test.ts`.
 */
describe('stageLocalSharedEdits dryRun x onPreview event matrix', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;
  const TS = '20260810-000000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-mirror-matrix-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
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

  it('dryRun true with an onPreview sink: the sink receives the event, nothing is written, no backup is taken', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const events: unknown[] = [];

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS, {
      dryRun: true,
      onPreview: (e) => events.push(e),
    });

    expect(events).toEqual([
      {
        kind: 'mirror',
        name: 'CLAUDE.md',
        localPath: join(claudeDir, 'CLAUDE.md'),
        repoPath: join(sharedDir, 'CLAUDE.md'),
      },
    ]);
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# repo copy\n');
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', TS);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('dryRun true with no sink: the log fallback line fires and still nothing is written', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS, { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('would capture: '));
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# repo copy\n');
  });

  it('dryRun false with a sink: the copy lands AND the sink receives the event', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const events: unknown[] = [];

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS, { onPreview: (e) => events.push(e) });

    expect(events).toEqual([
      {
        kind: 'mirror',
        name: 'CLAUDE.md',
        localPath: join(claudeDir, 'CLAUDE.md'),
        repoPath: join(sharedDir, 'CLAUDE.md'),
      },
    ]);
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# host edit\n');
  });

  it('dryRun false with no sink: the copy lands and nothing is logged (the pre-phase behavior commands.push.ts still depends on)', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(logSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# host edit\n');
  });

  it.skipIf(isWin)(
    'platform gate: a non-win32 host mirrors nothing, even under dryRun with a sink attached',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
      const events: unknown[] = [];

      const { stageLocalSharedEdits } = await import('./links.mirror.ts');
      stageLocalSharedEdits({ projects: {} }, TS, {
        dryRun: true,
        onPreview: (e) => events.push(e),
      });

      expect(events).toEqual([]);
      expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# repo copy\n');
    },
  );

  it('null-map gate: a null map mirrors nothing, even under dryRun with a sink attached', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# repo copy\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# host edit\n');
    stubPlatform('win32');
    const events: unknown[] = [];

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits(null, TS, { dryRun: true, onPreview: (e) => events.push(e) });

    expect(events).toEqual([]);
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# repo copy\n');
  });
});

/**
 * The mirror's copy-time filter runs against the full `NEVER_SYNC` set, not the
 * five-name `ALWAYS_NEVER_SYNC` subset. Every path this mirror writes lives
 * under `shared/<name>` and never under `shared/extras/`, so that set is
 * exactly what the repo-working-tree gate resolves for the same path; running
 * it here means the path is simply never written.
 *
 * `NEVER_SYNC` carries ordinary-sounding directory names authored against
 * `~/.claude/` semantics, so this is a user-facing behavior change and gets a
 * test that names the generic entry it uses rather than reaching for an
 * obviously-secret one. Pinned in both directions: a name that is now refused,
 * and a name that still passes.
 */
describe('copy-time denylist (NEVER_SYNC, not just the ALWAYS_NEVER_SYNC subset)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;
  const TS = '20260810-010000';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-mirror-denylist-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    delete process.env.NOMAD_REPO;
    sharedDir = join(testHome, 'claude-nomad', 'shared');
    claudeDir = join(testHome, '.claude');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
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

  it('refuses a directory segment spelled exactly like the generic NEVER_SYNC entry "sessions"', async () => {
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# token: abc\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(existsSync(join(sharedDir, 'commands', 'sessions'))).toBe(false);
  });

  it('still mirrors an ordinary shared file, so the widening did not blanket-refuse', async () => {
    writeFileSync(join(claudeDir, 'commands', 'deploy.md'), '# deploy\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(readFileSync(join(sharedDir, 'commands', 'deploy.md'), 'utf8')).toBe('# deploy\n');
  });

  it('leaves a file named tasks.md alone: isDeniedName matches whole segments, not substrings', async () => {
    // `tasks` is a NEVER_SYNC entry, but only a path segment spelled exactly
    // `tasks` collides. A user's `tasks.md` command file is untouched.
    writeFileSync(join(claudeDir, 'commands', 'tasks.md'), '# my tasks\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(readFileSync(join(sharedDir, 'commands', 'tasks.md'), 'utf8')).toBe('# my tasks\n');
  });

  it('still refuses a credential-shaped name, unchanged from the narrower subset', async () => {
    // The credential-pattern axis already covered `.env` through isDeniedName;
    // widening the exact-name set must not have regressed it.
    writeFileSync(join(claudeDir, 'commands', '.env'), 'TOKEN=abc\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(existsSync(join(sharedDir, 'commands', '.env'))).toBe(false);
  });

  it('applies the same refusal on the push mirror, which routes through copyExtrasFiltered', async () => {
    // The pull mirror overlays (copyExtrasOverlayFiltered); the push mirror
    // replaces (copyExtrasFiltered). Both call sites take the widened set.
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# token: abc\n');
    writeFileSync(join(claudeDir, 'commands', 'deploy.md'), '# deploy\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(existsSync(join(sharedDir, 'commands', 'sessions'))).toBe(false);
    expect(readFileSync(join(sharedDir, 'commands', 'deploy.md'), 'utf8')).toBe('# deploy\n');
  });
});
