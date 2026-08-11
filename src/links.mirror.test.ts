import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as fsModule from 'node:fs';
import type * as gitProbeModule from './git-probe.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { g, gitInit, gitOut } from './test-support/git.ts';
import { stubPlatform } from './test-helpers.platform.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. Gates the one
 * backstop case below that needs a real checkout (a staged-added path with no
 * HEAD version to restore from); the rest need no git at all.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

  it.skipIf(isWin)(
    'skips a name whose local path cannot be stat-ed at all, degrading rather than throwing',
    async () => {
      // `throwIfNoEntry: false` suppresses ENOENT only, so a locked path still
      // throws. `computePreview` (preview.ts) calls this mirror directly, with
      // no enclosing try/catch of its own, and its whole value is being safe
      // to run, so a locked path must degrade to a skipped name rather than a
      // crash report.
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
      chmodSync(claudeDir, 0o000);
      stubPlatform('win32');
      try {
        const { stageLocalSharedEdits } = await import('./links.mirror.ts');
        expect(() => stageLocalSharedEdits({ projects: {} }, TS)).not.toThrow();
      } finally {
        chmodSync(claudeDir, 0o700);
      }
      expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
    },
  );

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

/**
 * Unit cover for the backstop's per-path dispatch, sitting under the
 * end-to-end fixtures in `commands.pull.win32.test.ts`. These drive
 * `revertDeniedMirrorPaths` with hand-built path lists so each failure branch
 * can be reached directly: an unremovable path, a tracked path git cannot
 * restore, and a tracked path that is no longer in the working tree.
 *
 * Every case asserts the call returns normally. Nothing in this path may fail
 * a pull.
 */
describe('revertDeniedMirrorPaths', () => {
  let testHome: string;
  let repo: string;
  let originalHome: string | undefined;
  let errSpy: MockInstance<(...args: unknown[]) => void>;
  const TS = '20260810-030000';

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-revert-denied-'));
    // HOME drives backupBase(), which the removal branch now snapshots into.
    // Without this the snapshots would land in the developer's real
    // ~/.cache/claude-nomad/backup/.
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    repo = join(testHome, 'repo');
    mkdirSync(join(repo, 'shared', 'commands'), { recursive: true });
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    vi.doUnmock('./git-probe.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  /** Every captured stderr line joined, for substring assertions. */
  function warnings(): string {
    return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  /** Absolute path of the pull-side repo snapshot for `rel` under this run's ts. */
  function backupOf(rel: string): string {
    return join(testHome, '.cache', 'claude-nomad', 'backup', TS, 'repo', rel);
  }

  it('warns and moves on when an untracked hit cannot be removed', async () => {
    // Stands in for the real throwing cases: an antivirus lock, a read-only
    // file, a path over the Windows limit.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        rmSync: () => {
          throw new Error('EPERM: operation not permitted');
        },
      };
    });

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    expect(() =>
      revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/sessions'] }, TS),
    ).not.toThrow();

    expect(warnings()).toContain('could not remove');
    expect(warnings()).toContain('EPERM');
    expect(existsSync(join(repo, 'shared', 'commands', 'sessions'))).toBe(true);
  });

  it('says the path survived rather than claiming a removal that did not happen', async () => {
    // `force` makes rmSync treat an absent path as success, so a no-op removal
    // is indistinguishable from a real one at the call. A path that survives it
    // (a name whose bytes do not round-trip through git's stdout decode, or a
    // path that moved between the snapshot and here) must not be reported as
    // removed: the user would believe a denylisted file left the working tree
    // while it is still one `git add` from the remote.
    const abs = join(repo, 'shared', 'commands', 'settings.local.json');
    writeFileSync(abs, '{"apiKey":"x"}\n');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, rmSync: () => undefined };
    });

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: [], untracked: ['shared/commands/settings.local.json'] },
      TS,
    );

    expect(warnings()).toContain('could not remove');
    expect(warnings()).toContain('remove it by hand');
    expect(warnings()).not.toContain('removed shared/');
    expect(existsSync(abs)).toBe(true);
  });

  it('removes a denylisted untracked directory, which git reports as one record', async () => {
    // `--untracked-files=all` does not descend into a nested git repository, so
    // an untracked directory can arrive as a single record and the removal has
    // to be recursive to act on it at all.
    const dir = join(repo, 'shared', 'commands', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/sessions'] }, TS);

    expect(existsSync(dir)).toBe(false);
    expect(warnings()).toContain('removed shared/commands/sessions');
  });

  it('snapshots an untracked hit into the pull backup before removing it', async () => {
    // The only destructive branch in the pre-pull reconcile that had no
    // snapshot behind it. Git never had the path, so without one the removal is
    // unrecoverable, which is a strictly worse failure than the leak the gate
    // prevents when it fires on a false positive.
    const dir = join(repo, 'shared', 'commands', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/sessions'] }, TS);

    expect(existsSync(dir)).toBe(false);
    const snapshot = backupOf(join('shared', 'commands', 'sessions', 'notes.md'));
    expect(readFileSync(snapshot, 'utf8')).toBe('token=abc\n');
    // The WARN is the gate's only user-facing record, so it has to name where
    // the copy went or the snapshot may as well not exist.
    expect(warnings()).toContain(`backup/${TS}/repo/`);
  });

  it('lands the snapshot outside the sync repo, where no push can stage or scan it', async () => {
    // The snapshotted bytes are denylisted by definition (a credential-shaped
    // name, or a never-synced directory). A snapshot inside the repo would hand
    // the next push exactly the content this gate just removed.
    const abs = join(repo, 'shared', 'commands', 'settings.local.json');
    writeFileSync(abs, '{"apiKey":"x"}\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: [], untracked: ['shared/commands/settings.local.json'] },
      TS,
    );

    expect(existsSync(abs)).toBe(false);
    expect(existsSync(backupOf(join('shared', 'commands', 'settings.local.json')))).toBe(true);
    // Nothing under the repo, at any depth, holds a copy.
    const survivors = readdirSync(repo, { recursive: true, encoding: 'utf8' });
    expect(survivors.some((p) => p.includes('settings.local.json'))).toBe(false);
    expect(survivors.some((p) => p.includes('backup'))).toBe(false);
  });

  it('leaves a tracked hit that is no longer in the working tree alone, silently', async () => {
    // Already deleted (the deletion pass removed it, or the user did).
    // Checking it out of HEAD would put the denylisted content back.
    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(existsSync(join(repo, 'shared', 'commands', 'sessions'))).toBe(false);
    expect(warnings()).toBe('');
  });

  it('reverts nothing and warns nothing when neither list holds a denylisted path', async () => {
    writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# deploy\n');
    writeFileSync(join(repo, 'shared', 'commands', 'new.md'), '# new\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/deploy.md'], untracked: ['shared/commands/new.md'] },
      TS,
    );

    expect(existsSync(join(repo, 'shared', 'commands', 'deploy.md'))).toBe(true);
    expect(existsSync(join(repo, 'shared', 'commands', 'new.md'))).toBe(true);
    expect(warnings()).toBe('');
  });

  it.skipIf(!hasGit)('unstages a staged-added hit and leaves the file on disk', async () => {
    // Staged-added: git status calls it tracked, but there is no HEAD version,
    // so a restore can only fail on it. It is also the state where the content
    // is closest to publication, so the gate has to act rather than print a
    // sentence. Unstaging is the narrowest action that changes that, and it
    // destroys nothing.
    writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# deploy\n');
    gitInit(repo);
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'base'], repo);
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');
    g(['add', 'shared/commands/sessions/notes.md'], repo);

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    expect(() =>
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
        TS,
      ),
    ).not.toThrow();

    // Out of the index: the next commit no longer publishes it.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo,
    }).toString();
    expect(staged).not.toContain('sessions/notes.md');
    // Still on disk, untouched: the gate never deletes what the user put there.
    expect(existsSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'))).toBe(true);
    expect(readFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'utf8')).toBe(
      'token=abc\n',
    );
    // The WARN has to name both halves, or the user acts on the wrong one.
    expect(warnings()).toContain('unstaged shared/commands/sessions/notes.md');
    expect(warnings()).toContain('sessions');
    expect(warnings()).toContain('still on disk');
  });

  it.skipIf(!hasGit)(
    'undoes a staged rename into a denylisted path, staging no deletion of the source',
    async () => {
      // A user reorganizing shared/commands/ into a tasks/ subfolder and running
      // `git add -A` produces one R record spanning two index entries. Dropping
      // only the destination entry leaves the source's staged DELETION behind,
      // so the next push publishes the removal of a committed file and every
      // other host loses it on its next pull. Both halves have to be undone.
      mkdirSync(join(repo, 'shared', 'commands'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'foo.md'), '# committed\n');
      gitInit(repo);
      g(['add', '-A'], repo);
      g(['commit', '-qm', 'base'], repo);
      mkdirSync(join(repo, 'shared', 'commands', 'tasks'), { recursive: true });
      g(['mv', 'shared/commands/foo.md', 'shared/commands/tasks/foo.md'], repo);

      // Parsed from the real snapshot the backstop is fed, so the rename pairing
      // is exercised end to end rather than hand-built.
      const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
      const status = parsePorcelainZ(
        execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'], {
          cwd: repo,
        }).toString(),
      );
      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, status, TS);

      // Nothing staged at all: no add of the denied destination, and crucially
      // no deletion of the committed source.
      expect(gitOut(['diff', '--cached', '--name-status'], repo)).toBe('');
      // The committed source is back in the working tree with its content.
      expect(readFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'utf8')).toBe(
        '# committed\n',
      );
      // The denied copy stays on disk, untracked, exactly as the plain
      // staged-add branch leaves it.
      expect(existsSync(join(repo, 'shared', 'commands', 'tasks', 'foo.md'))).toBe(true);
      expect(warnings()).toContain('unstaged shared/commands/tasks/foo.md');
      expect(warnings()).toContain('shared/commands/foo.md');
    },
  );

  it.skipIf(!hasGit)(
    'leaves a committed tracked hit restored from HEAD, not unstaged',
    async () => {
      // The committed case is unchanged: deleting or unstaging a path whose
      // content IS in HEAD would turn a content gate into a loss of committed
      // repo content, which is worse than the leak it prevents.
      mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), '# committed\n');
      gitInit(repo);
      g(['add', '-A'], repo);
      g(['commit', '-qm', 'base'], repo);
      writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
        TS,
      );

      expect(readFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'utf8')).toBe(
        '# committed\n',
      );
      expect(warnings()).toContain('restored shared/commands/sessions/notes.md');
    },
  );

  it.skipIf(!hasGit)(
    'restores a committed gitlink rather than unstaging it, where a blob probe fails open',
    async () => {
      // The concrete deterministic trigger for the fail-open: a gitlink under
      // shared/ IS committed, but its commit object lives in the submodule's
      // object store, so a `cat-file -e HEAD:<path>` blob probe fails on it.
      // Reading that failure as "no committed content to protect" stages a
      // deletion of a committed entry. A tree lookup answers correctly.
      writeFileSync(join(repo, 'shared', 'commands', 'keep.md'), '# keep\n');
      gitInit(repo);
      g(['add', '-A'], repo);
      g(['commit', '-qm', 'base'], repo);
      g(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${'1'.repeat(40)},shared/commands/sessions`,
        ],
        repo,
      );
      g(['commit', '-qm', 'gitlink'], repo);
      mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, { tracked: ['shared/commands/sessions'], untracked: [] }, TS);

      // No staged deletion of the committed gitlink entry.
      expect(gitOut(['diff', '--cached', '--name-status'], repo)).toBe('');
      expect(warnings()).not.toContain('unstaged');
    },
  );

  it.skipIf(!hasGit)('leaves the index alone when the HEAD probe cannot answer', async () => {
    // Every failure mode of the probe collapses to null: git absent, the probe
    // timeout, an unborn or corrupt HEAD, a promisor clone that cannot
    // materialize the object. Only one of those means "nothing committed is at
    // risk", so null must never select the mutating branch. gitTryMutate is
    // left real here, so a regression genuinely stages the deletion.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
    writeFileSync(abs, '# committed\n');
    gitInit(repo);
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'base'], repo);
    writeFileSync(abs, 'token=abc\n');
    vi.doMock('./git-probe.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof gitProbeModule>()),
      gitProbe: () => null,
    }));

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(gitOut(['diff', '--cached', '--name-status'], repo)).toBe('');
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain('could not check shared/commands/sessions/notes.md against HEAD');
    expect(warnings()).not.toContain('unstaged');
  });

  it('warns that it could not restore when HEAD has the content but the checkout fails', async () => {
    // The two git calls in this branch answer different questions and are
    // spelled differently for that reason: the read-only tree lookup says HEAD
    // carries the path, so it is not a staged add, and the mutating checkout is
    // then the step that fails. Fail-open means the file is left exactly as it
    // was found, so the WARN has to send the user to it.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
    writeFileSync(abs, 'token=abc\n');
    vi.doMock('./git-probe.ts', () => ({
      gitProbe: () => 'shared/commands/sessions/notes.md\n',
      gitTryMutate: () => null,
    }));

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(warnings()).toContain('could not restore shared/commands/sessions/notes.md');
    expect(warnings()).toContain('remove it by hand');
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
  });

  it('says it could not check HEAD when the path is not in a git checkout at all', async () => {
    // No git repo here, so the HEAD probe fails. Claiming the path was unstaged
    // would be the same false record the removal branch avoids, and acting on
    // the guess would be the fail-open the probe branch exists to close.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(warnings()).toContain('could not check shared/commands/sessions/notes.md against HEAD');
    expect(warnings()).toContain('by hand');
    expect(existsSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'))).toBe(true);
  });
});

/**
 * Pins the invariant `nomad sync`'s no-op collapse rests on.
 *
 * `isNoopSync` (`commands.sync.ts`) can print `already in sync`, and so drop
 * the whole `Symlinks` section, only when the push half returns the `nothing`
 * tag. `runPushCore` returns that tag only when `gitStatusPorcelainZ` over the
 * sync repo comes back empty. So the question the collapse actually turns on is
 * not whether the mirror emitted events (it emits one per name it copies,
 * changed or not) but whether the copy changed the repo working tree.
 *
 * The two cases below answer it against real git, using the same status reader
 * the push half short-circuits on. A capture that carries a real host edit is
 * visible to that reader, so the run cannot reach the collapse; a capture that
 * rewrites byte-identical content is not, and `already in sync` is then the
 * accurate report.
 */
describe('a win32 mirror capture vs the push half empty-status short-circuit', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;
  const TS = '20260810-111111';

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-mirror-noop-'));
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

  /**
   * Commit `shared/CLAUDE.md` so the repo side is tracked with committed
   * content, which is what makes the capture below a modification git can see
   * rather than an untracked add (the latter would prove nothing about a real
   * host whose shared config is already published).
   *
   * @param content - The committed repo-side content.
   */
  function seedCommittedShared(content: string): void {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), content);
    gitInit(repoUnderHome);
    g(['add', '.'], repoUnderHome);
    g(['commit', '-q', '-m', 'seed'], repoUnderHome);
  }

  /**
   * Run the pre-pull mirror on a win32-stubbed platform, collecting its events.
   *
   * @returns The events the mirror emitted, one per name it copied.
   */
  async function runMirror(): Promise<unknown[]> {
    stubPlatform('win32');
    const events: unknown[] = [];
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS, { onPreview: (e) => events.push(e) });
    return events;
  }

  it.skipIf(!hasGit)(
    'a capture carrying a real host edit leaves a non-empty status, so the push half cannot report nothing',
    async () => {
      seedCommittedShared('# published shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# unpublished host edit\n');

      const events = await runMirror();
      const { gitStatusPorcelainZ } = await import('./utils.ts');
      const status = gitStatusPorcelainZ(repoUnderHome, { untrackedAll: true });

      expect(events).toHaveLength(1);
      expect(status).not.toBe('');
      expect(status).toContain('shared/CLAUDE.md');
    },
  );

  it.skipIf(!hasGit)(
    'a capture of byte-identical content leaves an empty status, which is the only state that reaches the collapse',
    async () => {
      seedCommittedShared('# published shared\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# published shared\n');

      const events = await runMirror();
      const { gitStatusPorcelainZ } = await import('./utils.ts');
      const status = gitStatusPorcelainZ(repoUnderHome, { untrackedAll: true });

      // The mirror still emits its event (it copies unconditionally), so the
      // rows the collapse drops describe a copy that changed nothing.
      expect(events).toHaveLength(1);
      expect(status).toBe('');
    },
  );
});

/**
 * Regression cover for the parallel preview predictor this module's dryRun
 * mode retired: a second module that reproduced this mirror's gate order
 * independently, pinned to it only by an equivalence test. If a gate is ever
 * added to this mirror and the second implementation is not updated to match,
 * the two silently diverge and the preview stops describing what a real pull
 * would do. Both assertions below fail loudly instead of relying on a human
 * to remember the equivalence test exists.
 */
describe('the mirror is the only implementation of the capture gates', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));

  it('the retired parallel planner module is absent from src/', () => {
    expect(existsSync(join(HERE, 'links.captures.ts'))).toBe(false);
  });

  it('preview.ts imports this module and no sibling capture-planner module', () => {
    const source = readFileSync(join(HERE, 'preview.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(importLines.some((line) => line.includes("from './links.mirror.ts'"))).toBe(true);
    expect(importLines.some((line) => line.includes('captures'))).toBe(false);
  });
});
