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
    // Later cases in this describe re-import links.mirror.ts after
    // resetModules, and restoreAllMocks does not clear a doMock registration,
    // so without this they would get the throwing lstatSync too.
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('mirrors a local file edit and a local directory edit into an already-shared shared/ on win32', async () => {
    // Both repo counterparts pre-exist: this case proves an EDIT reaches the
    // repo, not that a new name is created (adoptNew: false means it never
    // creates one).
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local edit\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# local edit\n');
    expect(readFileSync(join(sharedDir, 'commands', 'foo.md'), 'utf8')).toBe('# local command\n');
  });

  it('does not publish a name the repo does not already share: publishing is a deliberate act, performed by nomad adopt', async () => {
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'private.md'), '# host-only\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(existsSync(join(sharedDir, 'rules'))).toBe(false);
    expect(readFileSync(join(claudeDir, 'rules', 'private.md'), 'utf8')).toBe('# host-only\n');
  });

  it('does not publish a local-only file name the repo does not already share (the file-type half of the same contract)', async () => {
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local only\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# local only\n');
  });

  it('keeps publishing an already-shared name on every push (the half this policy did NOT change)', async () => {
    mkdirSync(join(sharedDir, 'rules'), { recursive: true });
    writeFileSync(join(sharedDir, 'rules', 'existing.md'), '# already published\n');
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'existing.md'), '# host edit\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(readFileSync(join(sharedDir, 'rules', 'existing.md'), 'utf8')).toBe('# host edit\n');
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
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');
    writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{"secret":true}');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(existsSync(join(sharedDir, 'commands', 'foo.md'))).toBe(true);
    expect(existsSync(join(sharedDir, 'commands', 'settings.local.json'))).toBe(false);
  });

  it('skips a name absent from ~/.claude/ silently, without throwing', async () => {
    // No CLAUDE.md, commands, or rules under claudeDir at all. The silence is
    // load-bearing: `throwIfNoEntry: false` is what keeps an ordinary fresh
    // host from warning once per shared name, so dropping the option (or
    // switching to statSync) must fail here rather than in the field.
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    expect(() => syncSharedLinksPush({ projects: {} })).not.toThrow();
    expect(existsSync(join(sharedDir, 'CLAUDE.md'))).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
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
    // Both repo counterparts must pre-exist: without shared/CLAUDE.md, the
    // notShared early return fires before the mocked lstatSync is ever
    // reached, the WARN never happens, and this case fails for a reason
    // that has nothing to do with the mock.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
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

    // Exactly one line for one unreadable name: a per-name warning that
    // multiplies across the shared list is what makes the output unreadable
    // when the real cause is an ACL change on the parent directory.
    const said = errSpy.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('CLAUDE.md could not be read');
    expect(said[0]).toContain('EPERM');
    // The actionable half of the advisory is the point of the warning, so pin
    // it: a truncation back to the bare first clause must fail here.
    expect(said[0]).toContain('left out of shared/ this run');
    expect(said[0]).toContain('another program has it open');
    // Nothing was written for the unreadable name (the repo-side copy is
    // still its original content, untouched by the failed stat), and the
    // pass carried on to the rest of the list rather than aborting at the
    // first bad entry.
    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
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
    // Later cases in this describe re-import links.mirror.ts after
    // resetModules, and restoreAllMocks does not clear a doMock registration,
    // so without this they would get the throwing lstatSync too.
    vi.doUnmock('node:fs');
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
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* captured */
      });
      try {
        const { stageLocalSharedEdits } = await import('./links.mirror.ts');
        expect(() => stageLocalSharedEdits({ projects: {} }, TS)).not.toThrow();
      } finally {
        chmodSync(claudeDir, 0o700);
      }
      expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# original shared\n');
      // The unreadable parent takes down the stat for every shared name, but
      // only CLAUDE.md has a shared/ counterpart this pull would have
      // captured. The other three are host-private under `adoptNew: false`, so
      // warning about them would report a loss that was never going to happen.
      const said = errSpy.mock.calls.map((c) => String(c[0]));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('CLAUDE.md could not be read');
      expect(said[0]).toContain('left out of shared/ this run');
    },
  );

  it('stays silent for an unreadable name the repo does not share', async () => {
    // `adoptNew: false` means a host-private name is never published by a
    // pull, readable or not, so an unreadable one costs nothing and must not
    // be reported as a lost capture.
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# local command\n');
    const blocked = join(claudeDir, 'commands');
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        lstatSync: (p: fsModule.PathLike, opts?: fsModule.StatSyncOptions) => {
          if (String(p) === blocked) throw new Error('EBUSY: resource busy or locked');
          return actual.lstatSync(p, opts);
        },
      };
    });
    stubPlatform('win32');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    expect(() => stageLocalSharedEdits({ projects: {} }, TS)).not.toThrow();

    expect(errSpy).not.toHaveBeenCalled();
    expect(existsSync(join(sharedDir, 'commands'))).toBe(false);
  });

  it('warns with read-only wording, not a write claim, when dryRun is true and a name cannot be stat-ed', async () => {
    // The dry-run callers (nomad diff, pull --dry-run, the pre-pull reconcile
    // planner, the wedge-recovery discard tally) never write to shared/ at
    // all, so the wording must not claim a repo-side omission the way the wet
    // caller's does.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# original shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# unpublished local edit\n');
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

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    expect(() => stageLocalSharedEdits({ projects: {} }, TS, { dryRun: true })).not.toThrow();

    const said = errSpy.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('CLAUDE.md could not be read');
    expect(said[0]).toContain('EPERM');
    expect(said[0]).toContain('nothing was captured for it and nothing was written');
    expect(said[0]).toContain('A pull that captures shared edits would skip it too');
    // `dryRun` means this call writes nothing, not that the user is looking at
    // a preview: describeSkippedMirrorDiscard passes it from inside a real
    // pull, so preview framing would be wrong there.
    expect(said[0]).not.toContain('preview');
    expect(said[0]).toContain('another program has it open');
    expect(said[0]).not.toContain('shared/ this run');
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
    // The byte-silence contract is success-only: an unreadable name warns
    // whether or not a sink is attached. Spying stderr as well pins which half
    // of that contract this case is actually guarding.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });

    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
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
 * The copy-time denylist under a shared name, now the credential and
 * host-config floor (`ALWAYS_NEVER_SYNC`) rather than the full `NEVER_SYNC`
 * set. `NEVER_SYNC` was authored against `~/.claude/`'s own directory
 * semantics and carries several ordinary-sounding runtime-state names, so a
 * user's `sharedDirs` content legitimately containing a directory spelled
 * exactly like one of those used to stop being mirrored: a user-facing
 * behavior change pinned in both directions below. It is pinned again here,
 * inverted: an ordinary directory name is now carried rather than silently
 * dropped, also a user-facing behavior change, and also pinned in both
 * directions.
 */
describe('copy-time denylist (ALWAYS_NEVER_SYNC, the credential and host-config floor)', () => {
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

  it('carries a directory segment spelled exactly like the generic NEVER_SYNC entry "sessions"', async () => {
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# token: abc\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(readFileSync(join(sharedDir, 'commands', 'sessions', 'notes.md'), 'utf8')).toBe(
      '# token: abc\n',
    );
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

  it('applies the same carry on the push mirror, which routes through copyExtrasFiltered', async () => {
    // The pull mirror overlays (copyExtrasOverlayFiltered); the push mirror
    // replaces (copyExtrasFiltered). Both call sites take the narrow set.
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# token: abc\n');
    writeFileSync(join(claudeDir, 'commands', 'deploy.md'), '# deploy\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    expect(readFileSync(join(sharedDir, 'commands', 'sessions', 'notes.md'), 'utf8')).toBe(
      '# token: abc\n',
    );
    expect(readFileSync(join(sharedDir, 'commands', 'deploy.md'), 'utf8')).toBe('# deploy\n');
  });

  it('still refuses a nested exact-name hit: settings.local.json never lands in shared/', async () => {
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{"host":"local"}\n');

    stubPlatform('win32');
    const { stageLocalSharedEdits } = await import('./links.mirror.ts');
    stageLocalSharedEdits({ projects: {} }, TS);

    expect(existsSync(join(sharedDir, 'commands', 'settings.local.json'))).toBe(false);
  });

  it('round-trips through copySharedLinkPull: what the write half carries in is what the read half carries back out', async () => {
    // The write half and the read half now apply the identical set for the
    // first time, so what a push mirrors into shared/ is exactly what a pull
    // mirrors back onto a host, with nothing stripped in one direction that
    // survived in the other.
    mkdirSync(join(claudeDir, 'commands', 'sessions'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'sessions', 'notes.md'), '# token: abc\n');
    writeFileSync(join(claudeDir, 'commands', 'deploy.md'), '# deploy\n');

    stubPlatform('win32');
    const { syncSharedLinksPush } = await import('./links.mirror.ts');
    syncSharedLinksPush({ projects: {} });

    const { copySharedLinkPull } = await import('./links.ts');
    const pulledDest = join(testHome, 'pulled-commands');
    mkdirSync(pulledDest, { recursive: true });
    copySharedLinkPull(join(sharedDir, 'commands'), pulledDest);

    expect(readFileSync(join(pulledDest, 'sessions', 'notes.md'), 'utf8')).toBe('# token: abc\n');
    expect(readFileSync(join(pulledDest, 'deploy.md'), 'utf8')).toBe('# deploy\n');
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
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'credentials', 'notes.md'), 'token=abc\n');
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
      revertDeniedMirrorPaths(
        repo,
        { tracked: [], untracked: ['shared/commands/credentials'] },
        TS,
      ),
    ).not.toThrow();

    expect(warnings()).toContain('could not remove');
    expect(warnings()).toContain('EPERM');
    expect(existsSync(join(repo, 'shared', 'commands', 'credentials'))).toBe(true);
  });

  it('says the path survived rather than claiming a removal that did not happen', async () => {
    // `force` makes rmSync treat an absent path as success, so a no-op removal
    // is indistinguishable from a real one at the call. A path that survives it
    // (a name whose bytes do not round-trip through git's stdout decode, or a
    // path that moved between the snapshot and here) must not be reported as
    // removed: the user would believe a denylisted file left the working tree
    // while it is still one `git add` from the remote.
    //
    // This block deliberately keeps fixtures on both match axes: most cases use
    // `credentials` (the shape axis, denied under either set), and this one uses
    // `settings.local.json` (the exact-name axis, one of the five floor names).
    // The two arms of the predicate can regress independently.
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
    const dir = join(repo, 'shared', 'commands', 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/credentials'] }, TS);

    expect(existsSync(dir)).toBe(false);
    expect(warnings()).toContain('removed shared/commands/credentials');
  });

  it('snapshots an untracked hit into the pull backup before removing it', async () => {
    // The only destructive branch in the pre-pull reconcile that had no
    // snapshot behind it. Git never had the path, so without one the removal is
    // unrecoverable, which is a strictly worse failure than the leak the gate
    // prevents when it fires on a false positive.
    const dir = join(repo, 'shared', 'commands', 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/credentials'] }, TS);

    expect(existsSync(dir)).toBe(false);
    const snapshot = backupOf(join('shared', 'commands', 'credentials', 'notes.md'));
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
    const dir = join(repo, 'shared', 'commands', 'credentials');
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
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/credentials'] }, TS);

    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain('could not snapshot');
    expect(warnings()).toContain('ENOSPC');
    expect(warnings()).toContain('left in place');
    expect(warnings()).toContain('remove it by hand');
    expect(warnings()).not.toContain('could not remove');
    expect(warnings()).not.toContain('removed shared/');
  });

  it('reports no removal for a path git listed that is not on disk', async () => {
    // `force` makes rmSync treat an absent path as success, so the call cannot
    // tell a no-op removal from a real one. Without a presence probe ahead of
    // the write this reads as a clean removal of a denylisted file that is in
    // fact still wherever it was: worse than the silence the gate exists to
    // remove.
    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/credentials'] }, TS);

    expect(warnings()).toContain('nothing was removed for shared/commands/credentials');
    expect(warnings()).not.toContain('removed shared/commands/credentials');
    expect(warnings()).not.toContain('snapshotted');
    expect(existsSync(backupOf(join('shared', 'commands', 'credentials')))).toBe(false);
  });

  it.skipIf(isWin)('claims the removal of a dangling symlink it really did remove', async () => {
    // The case that separates "is something here" from "does it resolve".
    // existsSync answers for the target and says no, so probing with it skips
    // the backup (correctly, there are no bytes to copy) and then reports that
    // nothing was removed, while rmSync has already unlinked the link. Only
    // the removal claim is true here, and only the snapshot clause is not.
    const link = join(repo, 'shared', 'commands', 'credentials');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(repo, 'shared', 'commands', 'gone-target'), link);

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, { tracked: [], untracked: ['shared/commands/credentials'] }, TS);

    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(warnings()).toContain('removed shared/commands/credentials');
    expect(warnings()).not.toContain('nothing was removed');
    expect(warnings()).not.toContain('snapshotted');
  });

  // Root reads through mode 0o000, so under a root runner the probe would
  // answer normally and never reach the branch this exists for.
  it.skipIf(isWin || process.getuid?.() === 0)(
    'does not claim a path is absent when it cannot be stat-ed at all',
    async () => {
      // `throwIfNoEntry: false` suppresses ENOENT only, so a locked parent
      // still throws. Guessing absent there would report "nothing was
      // removed" about a denylisted path nobody has looked at; the honest
      // degradation is to attempt the removal and let it say what happened.
      const parent = join(repo, 'shared', 'commands');
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(parent, 'credentials'), 'token=abc\n');
      chmodSync(parent, 0o000);

      try {
        const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
        revertDeniedMirrorPaths(
          repo,
          { tracked: [], untracked: ['shared/commands/credentials'] },
          TS,
        );

        expect(warnings()).toContain('could not remove');
        expect(warnings()).not.toContain('nothing was removed');
        expect(warnings()).not.toContain('removed shared/commands/credentials');
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );

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
      mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
      const abs = join(repo, 'shared', 'commands', 'credentials', 'notes.md');
      writeFileSync(abs, 'token=abc\n');
      g(['add', 'shared/commands/credentials/notes.md'], repo);
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      expect(() =>
        revertDeniedMirrorPaths(
          repo,
          { tracked: ['shared/commands/credentials/notes.md'], untracked: [] },
          TS,
        ),
      ).not.toThrow();

      expect(stagedIndex()).toBe(before);
      expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
      expect(warnings()).toContain(
        'shared/commands/credentials/notes.md is staged and has no committed version',
      );
      expect(warnings()).toContain('"credentials"');
      expect(warnings()).toContain('git rm --cached -- shared/commands/credentials/notes.md');
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
      mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
      g(['mv', 'hosts/outside.md', 'shared/commands/credentials/outside.md'], repo);
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
      expect(existsSync(join(repo, 'shared', 'commands', 'credentials', 'outside.md'))).toBe(true);
      expect(warnings()).toContain(
        'shared/commands/credentials/outside.md is staged and has no committed version',
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
      mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'credentials', 'copy.md'), 'body\n');
      // Copy detection only pairs against a source the same change touched.
      writeFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'body\nedited\n');
      g(['add', '-A'], repo);
      const raw = execFileSync(
        'git',
        ['-c', 'status.renames=copies', 'status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'],
        { cwd: repo },
      ).toString();
      // Guard the fixture: without a real C record this case proves nothing.
      expect(raw).toContain('C  shared/commands/credentials/copy.md');
      const before = stagedIndex();

      const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(repo, parsePorcelainZ(raw), TS);

      expect(stagedIndex()).toBe(before);
      expect(readFileSync(join(repo, 'shared', 'commands', 'foo.md'), 'utf8')).toBe(
        'body\nedited\n',
      );
      expect(warnings()).toContain(
        'shared/commands/credentials/copy.md is staged and has no committed version',
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
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    const src = join(repo, 'shared', 'commands', 'credentials', 'src.md');
    writeFileSync(src, 'body\n');
    commitBase();
    writeFileSync(join(repo, 'shared', 'commands', 'credentials', 'copy.md'), 'body\n');
    // Copy detection only pairs against a source the same change touched.
    writeFileSync(src, 'body\nedited\n');
    g(['add', '-A'], repo);
    const raw = execFileSync(
      'git',
      ['-c', 'status.renames=copies', 'status', '--porcelain=v1', '-z', '-uall', '--', 'shared/'],
      { cwd: repo },
    ).toString();
    // Guard the fixture: without a real C record this case proves nothing.
    expect(raw).toContain('C  shared/commands/credentials/copy.md');
    const before = stagedIndex();

    const { parsePorcelainZ } = await import('./commands.pull.recovery.git.ts');
    const status = parsePorcelainZ(raw);
    // The duplicate is in the parse, which three other consumers depend on, so
    // it is the dispatch that has to absorb it.
    expect(status.tracked.filter((p) => p === 'shared/commands/credentials/src.md')).toHaveLength(
      2,
    );
    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(repo, status, TS);

    expect(stagedIndex()).toBe(before);
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      lines.filter((l) => l.includes('shared/commands/credentials/src.md is tracked')),
    ).toHaveLength(1);
    expect(
      lines.filter((l) => l.includes('shared/commands/credentials/copy.md is staged')),
    ).toHaveLength(1);
  });

  it('keeps a path listed as both tracked and untracked on both halves', async () => {
    // The de-duplication is per list, never across them: the two halves do
    // different things, so collapsing one path reported in both classifications
    // into a single visit would silently drop whichever half lost. git does not
    // emit that pairing today, which is exactly why the boundary has to be
    // pinned rather than assumed.
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'credentials', 'notes.md');
    writeFileSync(abs, 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      {
        tracked: ['shared/commands/credentials/notes.md'],
        untracked: ['shared/commands/credentials/notes.md'],
      },
      TS,
    );

    // Untracked half ran (the file is gone, snapshotted first)...
    expect(existsSync(abs)).toBe(false);
    expect(warnings()).toContain('removed shared/commands/credentials/notes.md');
    // ...and so did the tracked half, which cannot answer outside a checkout.
    expect(warnings()).toContain(
      'could not check shared/commands/credentials/notes.md against HEAD',
    );
  });

  it.skipIf(!hasGit)('reports a plain tracked modification without restoring it', async () => {
    // The committed case: the content IS in HEAD, so `git checkout HEAD --` is
    // the right command and the WARN names it. Running it here would discard a
    // working-tree edit the gate has no snapshot of.
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'credentials', 'notes.md');
    writeFileSync(abs, '# committed\n');
    commitBase();
    writeFileSync(abs, 'token=abc\n');
    const before = stagedIndex();

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/credentials/notes.md'], untracked: [] },
      TS,
    );

    expect(stagedIndex()).toBe(before);
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain(
      'shared/commands/credentials/notes.md is tracked and has changes against HEAD',
    );
    expect(warnings()).toContain('git checkout HEAD -- shared/commands/credentials/notes.md');
    expect(warnings()).not.toContain('restored');
    // Both options the WARN opened with leave the denylisted content committed,
    // so the third one has to say how it comes out and be honest that nothing
    // local reaches a copy a previous push already published.
    expect(warnings()).toContain('git rm -- shared/commands/credentials/notes.md');
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
          `160000,${'1'.repeat(40)},shared/commands/credentials`,
        ],
        repo,
      );
      g(['commit', '-qm', 'gitlink'], repo);
      mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
      writeFileSync(join(repo, 'shared', 'commands', 'credentials', 'notes.md'), 'token=abc\n');
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/credentials'], untracked: [] },
        TS,
      );

      expect(stagedIndex()).toBe(before);
      expect(warnings()).toContain(
        'shared/commands/credentials is tracked and has changes against HEAD',
      );
      expect(warnings()).toContain('git checkout HEAD -- shared/commands/credentials');
    },
  );

  it.skipIf(!hasGit)(
    'says nothing about a committed hit already gone from the working tree',
    async () => {
      // Already deleted (the deletion pass removed it, or the user did). There is
      // nothing left to act on, and naming `git checkout HEAD --` here would be
      // the one piece of advice that puts the denylisted content back.
      mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
      const abs = join(repo, 'shared', 'commands', 'credentials', 'notes.md');
      writeFileSync(abs, 'token=abc\n');
      commitBase();
      rmSync(abs);
      const before = stagedIndex();

      const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
      revertDeniedMirrorPaths(
        repo,
        { tracked: ['shared/commands/credentials/notes.md'], untracked: [] },
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
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    const abs = join(repo, 'shared', 'commands', 'credentials', 'notes.md');
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
      { tracked: ['shared/commands/credentials/notes.md'], untracked: [] },
      TS,
    );

    expect(stagedIndex()).toBe(before);
    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toContain(
      'could not check shared/commands/credentials/notes.md against HEAD',
    );
    expect(warnings()).toContain('git status -- shared/commands/credentials/notes.md');
    expect(warnings()).not.toContain('git rm --cached');
    expect(warnings()).not.toContain('git checkout HEAD');
  });

  it('says it could not check HEAD when the path is not in a git checkout at all', async () => {
    // No git repo here, so the HEAD lookup fails. Naming a command on that
    // guess is the fail-open the null branch exists to close.
    mkdirSync(join(repo, 'shared', 'commands', 'credentials'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'commands', 'credentials', 'notes.md'), 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: ['shared/commands/credentials/notes.md'], untracked: [] },
      TS,
    );

    expect(warnings()).toContain(
      'could not check shared/commands/credentials/notes.md against HEAD',
    );
    expect(warnings()).toContain('before committing');
    expect(existsSync(join(repo, 'shared', 'commands', 'credentials', 'notes.md'))).toBe(true);
  });

  it('leaves a widened name under a shared name completely alone', async () => {
    // The contract this phase settles: the backstop no longer deletes content
    // the host-to-repo writers legitimately produce under an adopted or
    // statically-shared name. `sessions` is a NEVER_SYNC-only name, so this is
    // the positive proof that the widening reaches this gate too.
    const dir = join(repo, 'shared', 'my-tools', 'sessions');
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, 'notes.md');
    writeFileSync(abs, 'token=abc\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    expect(() =>
      revertDeniedMirrorPaths(
        repo,
        { tracked: [], untracked: ['shared/my-tools/sessions/notes.md'] },
        TS,
      ),
    ).not.toThrow();

    expect(readFileSync(abs, 'utf8')).toBe('token=abc\n');
    expect(warnings()).toBe('');
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup', TS))).toBe(false);
  });

  // These two are win32-only in production (`revertDeniedUnderShared`, the
  // only caller, is reached from `src/commands.pull.win32.ts`), but
  // `revertDeniedMirrorPaths` itself is platform-independent, so neither test
  // needs a platform stub.

  it('leaves a projects logical named after a denylist token completely alone', async () => {
    // The destructive twin of the widening pinned in config.never-sync.test.ts:
    // before the scan-range fix this path was snapshotted and then recursively
    // removed, which is a legitimately-named project losing its transcripts to
    // the sync tool.
    const dir = join(repo, 'shared', 'projects', 'sessions');
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, 'x.jsonl');
    writeFileSync(abs, '{"type":"summary"}\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: [], untracked: ['shared/projects/sessions/x.jsonl'] },
      TS,
    );

    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('{"type":"summary"}\n');
    expect(existsSync(backupOf(join('shared', 'projects', 'sessions', 'x.jsonl')))).toBe(false);
    expect(warnings()).toBe('');
  });

  it("removes a floor name parked at an extras logical's own depth", async () => {
    // The destructive twin of the narrowing pinned in config.never-sync.test.ts:
    // before the scan-range fix this path survived, sitting above the old
    // segment-4 scan.
    const dir = join(repo, 'shared', 'extras', 'myproj');
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, 'settings.local.json');
    writeFileSync(abs, '{"apiKey":"x"}\n');

    const { revertDeniedMirrorPaths } = await import('./links.mirror.ts');
    revertDeniedMirrorPaths(
      repo,
      { tracked: [], untracked: ['shared/extras/myproj/settings.local.json'] },
      TS,
    );

    expect(existsSync(abs)).toBe(false);
    const snapshot = backupOf(join('shared', 'extras', 'myproj', 'settings.local.json'));
    expect(readFileSync(snapshot, 'utf8')).toBe('{"apiKey":"x"}\n');
    // Only the success-path line proves the removal happened. The bare
    // filename also appears in two of this function's failure warnings, so
    // asserting it alone would pass on a removal that failed.
    expect(warnings()).toContain('removed shared/extras/myproj/settings.local.json');
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
