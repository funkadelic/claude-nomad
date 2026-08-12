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
import type * as utilsFsModule from './utils.fs.ts';
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
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-test-push-mirror-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO over the $HOME fallback these fixtures
    // assume, so an ambient override would aim the mirror at a real checkout.
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
    // restoreAllMocks does not clear a doMock registration, so an un-mirrored
    // doMock leaks the throwing lstatSync into every later file in the project.
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
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

  it('warns and keeps going when a local name cannot be stat-ed', async () => {
    // `throwIfNoEntry: false` already absorbs ENOENT, so only a real error
    // reaches the catch: a permissions failure, a file another process holds
    // open on Windows, a broken mount. The name is skipped either way, but
    // skipping it silently would lose a local edit with no output at all.
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# unreadable local edit\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');
    const blocked = join(claudeDir, 'CLAUDE.md');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
          if (String(p) === blocked) throw new Error('EPERM: operation not permitted');
          return actual.lstatSync(p, opts);
        },
      };
    });
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    expect(() => syncSharedLinksPush({ projects: {} })).not.toThrow();

    const said = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('could not read');
    expect(said).toContain(blocked);
    expect(said).toContain('EPERM');
    // Nothing was written for the unreadable name, and the pass carried on to
    // the rest of the list rather than aborting at the first bad entry.
    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(sharedDir, 'commands', 'foo.md'))).toBe(true);
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

  // Root reads through mode 0o000, so under a root runner (common in
  // containers) the mirror would stat the path fine and copy the local edit,
  // failing an assertion that exists for the locked-path branch alone.
  it.skipIf(isWin || process.getuid?.() === 0)(
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
 * end-to-end fixtures in `commands.pull.win32.test.ts`.
 *
 * The untracked half writes, so its cases pin the snapshot, the removal and the
 * WARN that reports them. The tracked half writes NOTHING, so its cases pin two
 * things at once for every `git status` shape that can reach it: the WARN names
 * the path, the denylisted segment and the exact command for that shape, and
 * `git diff --cached --name-status` is byte-identical before and after the call.
 * The second assertion is the whole contract, so it is made per shape rather
 * than once: the shapes are the reason the tracked half stopped mutating.
 *
 * Every case asserts the call returns normally. Nothing in this path may fail
 * a pull.
 */
describe('revertDeniedMirrorPaths', () => {
  let testHome: string;
  let repo: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let errSpy: MockInstance<(...args: unknown[]) => void>;
  const TS = '20260810-030000';

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'nomad-revert-denied-'));
    // HOME drives backupBase(), which the removal branch now snapshots into.
    // Without this the snapshots would land in the developer's real
    // ~/.cache/claude-nomad/backup/. USERPROFILE is set alongside it because
    // `home()` prefers USERPROFILE on win32 and this suite does not stub the
    // platform, so on a native-Windows or Git Bash checkout HOME alone would
    // not redirect anything.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
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
    vi.doUnmock('./utils.fs.ts');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
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

  /**
   * The staged index as a comparable string. The tracked half of the backstop
   * is report-only, so every tracked case captures this before the call and
   * requires it back afterwards.
   */
  function stagedIndex(): string {
    return gitOut(['diff', '--cached', '--name-status'], repo);
  }

  /** Commit whatever is in `repo` as the base history the shapes build on. */
  function commitBase(): void {
    gitInit(repo);
    g(['add', '-A'], repo);
    g(['commit', '-qm', 'base'], repo);
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

  it('leaves an untracked hit in place when it cannot be snapshotted, and says so', async () => {
    // The snapshot is the whole reason this branch is allowed to delete
    // anything, and every way it can fail (no space in the cache directory, no
    // permission on it, a destination over the Windows path limit) says nothing
    // about whether the path is a genuine leak. So the removal is abandoned
    // rather than performed unbacked, and the WARN names the cache failure
    // instead of blaming the file, which would send the user to check the wrong
    // thing entirely.
    const dir = join(repo, 'shared', 'commands', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'token=abc\n');
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return {
        ...actual,
        backupRepoWrite: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      };
    });

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/sessions'] }, TS);

    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain('could not snapshot');
    expect(warnings()).toContain('ENOSPC');
    expect(warnings()).toContain('left in place');
    expect(warnings()).toContain('remove it by hand');
    expect(warnings()).not.toContain('could not remove');
    expect(warnings()).not.toContain('removed shared/');
  });

  it('does not name a snapshot for a path that was already gone', async () => {
    // `backupUnder` copies only a source it can resolve, and `force` makes
    // rmSync treat an absent path as success, so a path that vanished between
    // the git status snapshot and this call leaves nothing under
    // backup/<ts>/repo/. Pointing the user at a directory holding no copy of
    // their file is the one claim worse than making no claim.
    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/sessions'] }, TS);

    expect(warnings()).toContain('shared/commands/sessions');
    expect(warnings()).not.toContain('snapshotted');
    expect(existsSync(backupOf(join('shared', 'commands', 'sessions')))).toBe(false);
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

  it.skipIf(!hasGit)(
    'reports a staged add and leaves the index exactly as it found it',
    async () => {
      // Staged-added: git status calls it tracked, but there is no HEAD version,
      // so this is the state where the content is closest to publication. The
      // gate says so and names the one command that takes it back out. It does
      // not run it: unstaging turns the path into an untracked record, which is
      // the shape the NEXT pull deletes, so the gate would be quietly queueing a
      // deletion of a file the user hand-placed.
      writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# deploy\n');
      commitBase();
      mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
      const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
      writeFileSync(abs, 'token=abc\n');
      g(['add', 'shared/commands/sessions/notes.md'], repo);
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      expect(() =>
        revertDeniedMirrorPaths(
          repo,
          { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
          TS,
        ),
      ).not.toThrow();

      expect(stagedIndex()).toBe(before);
      expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
      expect(warnings()).toContain(
        'shared/commands/sessions/notes.md is staged and has no committed version',
      );
      expect(warnings()).toContain('"sessions"');
      expect(warnings()).toContain('git rm --cached -- shared/commands/sessions/notes.md');
      expect(warnings()).toContain('Nothing was changed');
      // ...and it has to say what running that command leads to. Unstaging is
      // exactly what turns the path into an untracked record, which is the shape
      // the NEXT pull's removal branch acts on, so a WARN that stops at "take it
      // out of the index" leaves the user unaware their next pull deletes the
      // file, and offers no way to keep it.
      expect(warnings()).toContain('the next nomad pull removes from the sync repo working tree');
      expect(warnings()).toContain('snapshotting it into the backup cache first');
      expect(warnings()).toContain('move it outside shared/');
    },
  );

  it.skipIf(!hasGit)(
    'reports an AD record, whose index entry publishes with no file left to notice',
    async () => {
      // Staged and then deleted from the working tree. There is nothing on disk
      // to see, but the index still carries the blob and the next commit takes
      // it, so this is the shape that most needs saying out loud.
      writeFileSync(join(repo, 'shared', 'commands', 'deploy.md'), '# deploy\n');
      commitBase();
      const abs = join(repo, 'shared', 'commands', 'settings.local.json');
      writeFileSync(abs, '{"apiKey":"REAL"}\n');
      g(['add', '-A'], repo);
      rmSync(abs);
      const before = stagedIndex();
      expect(before).toContain('settings.local.json');

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/settings.local.json'], untracked: [] },
        TS,
      );

      expect(stagedIndex()).toBe(before);
      expect(warnings()).toContain(
        'shared/commands/settings.local.json is staged and has no committed version',
      );
      expect(warnings()).toContain('git rm --cached -- shared/commands/settings.local.json');
    },
  );

  it.skipIf(!hasGit)(
    'reports a rename whose source lives outside shared/, which git reports as a plain add',
    async () => {
      // The status snapshot is taken under a `-- shared/` pathspec and git
      // computes rename detection over the diff that pathspec produced, so this
      // arrives with no pairing at all. Acting on it dropped the destination and
      // left the source's staged deletion behind, publishing a removal of
      // committed content. Reporting it cannot: the WARN sends the user to the
      // command that shows both halves.
      mkdirSync(join(repo, 'hosts'), { recursive: true });
      writeFileSync(join(repo, 'hosts', 'outside.md'), '# committed\n');
      writeFileSync(join(repo, 'shared', 'commands', 'keep.md'), '# keep\n');
      commitBase();
      mkdirSync(join(repo, 'shared', 'commands', 'tasks'), { recursive: true });
      g(['mv', 'hosts/outside.md', 'shared/commands/tasks/outside.md'], repo);
      const before = stagedIndex();

      // Parsed from the real snapshot the backstop is fed, so the pathspec's
      // effect on rename detection is exercised rather than assumed.
      const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
      const status = parsePorcelainZ(
        execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'], {
          cwd: repo,
        }).toString(),
      );
      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, status, TS);

      expect(stagedIndex()).toBe(before);
      expect(existsSync(join(repo, 'shared', 'commands', 'tasks', 'outside.md'))).toBe(true);
      expect(warnings()).toContain(
        'shared/commands/tasks/outside.md is staged and has no committed version',
      );
      expect(warnings()).toContain('git diff --cached --name-status');
    },
  );

  it.skipIf(!hasGit)(
    'reports a copy destination and leaves the source it was copied from alone',
    async () => {
      // `status.renames=copies` is documented git configuration, and a copy
      // stages NO deletion of its source, so anything that "undid" the pairing
      // discarded the user's edit to a file nothing had removed.
      writeFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'body\n');
      commitBase();
      mkdirSync(join(repo, 'shared', 'commands', 'tasks'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'tasks', 'copy.md'), 'body\n');
      // Copy detection only pairs against a source the same change touched.
      writeFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'body\nedited\n');
      g(['add', '-A'], repo);
      const raw = execFileSync(
        'git',
        ['-c', 'status.renames=copies', 'status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'],
        { cwd: repo },
      ).toString();
      // Guard the fixture: without a real C record this case proves nothing.
      expect(raw).toContain('C  shared/commands/tasks/copy.md');
      const before = stagedIndex();

      const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, parsePorcelainZ(raw), TS);

      expect(stagedIndex()).toBe(before);
      expect(readFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'utf8')).toBe(
        'body\nedited\n',
      );
      expect(warnings()).toContain(
        'shared/commands/tasks/copy.md is staged and has no committed version',
      );
    },
  );

  it.skipIf(!hasGit)('reports a copy source once, though git reports it twice', async () => {
    // A `C` record carries its source as a second field AND git emits the
    // source's own `M` record alongside it, so the parsed tracked list holds
    // that path twice. Both halves have to sit under a denied segment to reach
    // this, which is why it took a copy to surface: nothing is mutated and the
    // assertion is true in this shape, so the whole defect is one user-facing
    // line printed twice, which reads as two separate hits.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const src = join(repo, 'shared', 'commands', 'sessions', 'src.md');
    writeFileSync(src, 'body\n');
    commitBase();
    writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'copy.md'), 'body\n');
    // Copy detection only pairs against a source the same change touched.
    writeFileSync(src, 'body\nedited\n');
    g(['add', '-A'], repo);
    const raw = execFileSync(
      'git',
      ['-c', 'status.renames=copies', 'status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'],
      { cwd: repo },
    ).toString();
    // Guard the fixture: without a real C record this case proves nothing.
    expect(raw).toContain('C  shared/commands/sessions/copy.md');
    const before = stagedIndex();

    const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
    const status = parsePorcelainZ(raw);
    // The duplicate is in the parse, which three other consumers depend on, so
    // it is the dispatch that has to absorb it.
    expect(status.tracked.filter((p) => p === 'shared/commands/sessions/src.md')).toHaveLength(2);
    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, status, TS);

    expect(stagedIndex()).toBe(before);
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      lines.filter((l) => l.includes('shared/commands/sessions/src.md is tracked')),
    ).toHaveLength(1);
    expect(
      lines.filter((l) => l.includes('shared/commands/sessions/copy.md is staged')),
    ).toHaveLength(1);
  });

  it('keeps a path listed as both tracked and untracked on both halves', async () => {
    // The de-duplication is per list, never across them: the two halves do
    // different things, so collapsing one path reported in both classifications
    // into a single visit would silently drop whichever half lost. git does not
    // emit that pairing today, which is exactly why the boundary has to be
    // pinned rather than assumed.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
    writeFileSync(abs, 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      {
        tracked: ['shared/commands/sessions/notes.md'],
        untracked: ['shared/commands/sessions/notes.md'],
      },
      TS,
    );

    // Untracked half ran (the file is gone, snapshotted first)...
    expect(existsSync(abs)).toBe(false);
    expect(warnings()).toContain('removed shared/commands/sessions/notes.md');
    // ...and so did the tracked half, which cannot answer outside a checkout.
    expect(warnings()).toContain('could not check shared/commands/sessions/notes.md against HEAD');
  });

  it.skipIf(!hasGit)('reports a plain tracked modification without restoring it', async () => {
    // The committed case: the content IS in HEAD, so `git checkout HEAD --` is
    // the right command and the WARN names it. Running it here would discard a
    // working-tree edit the gate has no snapshot of.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
    writeFileSync(abs, '# committed\n');
    commitBase();
    writeFileSync(abs, 'token=abc\n');
    const before = stagedIndex();

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(stagedIndex()).toBe(before);
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain(
      'shared/commands/sessions/notes.md is tracked and has changes against HEAD',
    );
    expect(warnings()).toContain('git checkout HEAD -- shared/commands/sessions/notes.md');
    expect(warnings()).not.toContain('restored');
    // Both options the WARN opened with leave the denylisted content committed,
    // so the third one has to say how it comes out and be honest that nothing
    // local reaches a copy a previous push already published.
    expect(warnings()).toContain('git rm -- shared/commands/sessions/notes.md');
    expect(warnings()).toContain('rotate');
    expect(warnings()).toContain('cannot scrub what a previous push already sent to the remote');
  });

  it.skipIf(!hasGit)(
    'reports a committed gitlink, which a tree lookup finds and a blob probe would not',
    async () => {
      // A gitlink under shared/ IS committed, but its commit object lives in the
      // submodule's object store, so a `cat-file -e HEAD:<path>` blob probe fails
      // on it. Reading that as "no committed content" would name the wrong
      // command. The tree lookup answers correctly.
      writeFileSync(join(repo, 'shared', 'commands', 'keep.md'), '# keep\n');
      commitBase();
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
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, { tracked: ['shared/commands/sessions'], untracked: [] }, TS);

      expect(stagedIndex()).toBe(before);
      expect(warnings()).toContain(
        'shared/commands/sessions is tracked and has changes against HEAD',
      );
      expect(warnings()).toContain('git checkout HEAD -- shared/commands/sessions');
    },
  );

  it.skipIf(!hasGit)(
    'says nothing about a committed hit already gone from the working tree',
    async () => {
      // Already deleted (the deletion pass removed it, or the user did). There is
      // nothing left to act on, and naming `git checkout HEAD --` here would be
      // the one piece of advice that puts the denylisted content back.
      mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
      const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
      writeFileSync(abs, 'token=abc\n');
      commitBase();
      rmSync(abs);
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
        TS,
      );

      expect(stagedIndex()).toBe(before);
      expect(existsSync(abs)).toBe(false);
      expect(warnings()).toBe('');
    },
  );

  it.skipIf(!hasGit)('names neither command when the HEAD lookup cannot answer', async () => {
    // Every failure mode of the probe collapses to null: git absent, the probe
    // timeout, an unborn or corrupt HEAD, a promisor clone that cannot
    // materialize the object. Only one of those means "not committed", so a
    // null must not pick a command on a guess.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'sessions', 'notes.md');
    writeFileSync(abs, '# committed\n');
    commitBase();
    writeFileSync(abs, 'token=abc\n');
    const before = stagedIndex();
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

    expect(stagedIndex()).toBe(before);
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain('could not check shared/commands/sessions/notes.md against HEAD');
    expect(warnings()).toContain('git status -- shared/commands/sessions/notes.md');
    expect(warnings()).not.toContain('git rm --cached');
    expect(warnings()).not.toContain('git checkout HEAD');
  });

  it('says it could not check HEAD when the path is not in a git checkout at all', async () => {
    // No git repo here, so the HEAD lookup fails. Naming a command on that
    // guess is the fail-open the null branch exists to close.
    mkdirSync(join(repo, 'shared', 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'sessions', 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/sessions/notes.md'], untracked: [] },
      TS,
    );

    expect(warnings()).toContain('could not check shared/commands/sessions/notes.md against HEAD');
    expect(warnings()).toContain('before committing');
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
    // The retired module's own specifier, not a bare `captures` substring: a
    // legitimate future import that merely spells the word would otherwise
    // fail this as if the planner had come back.
    expect(importLines.some((line) => line.includes('./links.captures.ts'))).toBe(false);
  });
});
