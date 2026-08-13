import {
  chmodSync,
  existsSync,
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

import { type PathMap } from './config.ts';
import { stubPlatform } from './test-helpers.platform.ts';

/** Real platform of the machine running the suite, restored in `afterEach`. */
const realPlatform = process.platform;

/**
 * Permission-based failure injection is a no-op on Windows, where `chmod` does
 * not restrict access; the branch it covers is counted on the posix leg.
 */
const isWin = realPlatform === 'win32';

/** Backup timestamp used by every applier call here. */
const TS = '20260803-000000';

describe('shared-link deletions', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let cacheDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-deletions-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO over the $HOME fallback these fixtures
    // assume, so an ambient export would aim an rmSync at a real checkout.
    delete process.env.NOMAD_REPO;
    claudeDir = join(testHome, '.claude');
    sharedDir = join(testHome, 'claude-nomad', 'shared');
    cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
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
   * Write a baseline by hand, bypassing the writer. Every negative case below
   * depends on this: the reader has to survive a file it did not produce, and a
   * hand-written record is the only way to inject a key the enumerator would
   * never have produced.
   *
   * @param files - Manifest `files` map, keyed by config-home-relative POSIX path.
   * @param scannerVersion - Producer tag; defaults to the real one.
   */
  function plantBaseline(files: Record<string, unknown>, scannerVersion?: string): void {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'shared-baseline-test-host.json'),
      JSON.stringify({
        schema: 1,
        scannerVersion: scannerVersion ?? 'shared-links-baseline/1',
        configHash: 'not-applicable',
        files,
      }) + '\n',
    );
  }

  /** Manifest entry shape; the values never matter, only the key's presence. */
  function entry(): { size: number; mtime: number; hash: string } {
    return { size: 1, mtime: 1, hash: 'x' };
  }

  /** Seed one file on both sides, so the state starts genuinely synced. */
  function seedSynced(relPath: string, content: string): void {
    writeFileSync(join(claudeDir, relPath), content);
    writeFileSync(join(sharedDir, relPath), content);
  }

  /**
   * Run the applier and assert the repo files listed are all still present with
   * unchanged bytes. Paired with an empty-plan assertion in every negative case:
   * checking only the returned array would pass against an applier that deleted
   * independently of the plan.
   */
  async function expectRepoUntouched(
    map: PathMap | null = { projects: {} },
    expected: Record<string, string> = { 'commands/a.md': '# a\n' },
  ): Promise<unknown[]> {
    const { applySharedLinkDeletions } = await import('./links.deletions.ts');
    const removed = applySharedLinkDeletions(map, TS);
    for (const [rel, content] of Object.entries(expected)) {
      expect(readFileSync(join(sharedDir, rel), 'utf8')).toBe(content);
    }
    return removed;
  }

  describe('baseline integrity: every failure mode deletes nothing', () => {
    beforeEach(() => {
      seedSynced('commands/a.md', '# a\n');
      // The user "deleted" the local copy; only the baseline decides whether
      // that authorizes removing the repo copy.
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
    });

    it('plans nothing when no baseline exists', async () => {
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('plans nothing on a malformed baseline', async () => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'shared-baseline-test-host.json'), '{ not json\n');
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(() => planSharedLinkDeletions({ projects: {} })).not.toThrow();
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('plans nothing on a baseline of the wrong shape', async () => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'shared-baseline-test-host.json'),
        JSON.stringify({ schema: 1, files: null }) + '\n',
      );
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('plans nothing on a shape-valid record from a different producer', async () => {
      // The concrete case: a push manifest copied onto the baseline path. It
      // satisfies the same structural guard, so the producer tag is the only
      // thing between a manifest mix-up and an authorized deletion.
      plantBaseline({ 'commands/a.md': entry() }, '8.30.1');
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('plans nothing when the map could not be read', async () => {
      plantBaseline({ 'commands/a.md': entry() });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions(null)).toEqual([]);
      await expectRepoUntouched(null);
    });

    it('plans nothing on a posix platform, never consulting the baseline', async () => {
      plantBaseline({ 'commands/a.md': entry() });
      stubPlatform('linux');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      const removed = await expectRepoUntouched();
      expect(removed).toEqual([]);
    });
  });

  describe('scoping: only a genuinely deleted file is propagated', () => {
    it('removes the repo file a baselined local deletion authorizes', async () => {
      seedSynced('commands/a.md', '# a\n');
      seedSynced('commands/b.md', '# b\n');
      plantBaseline({ 'commands/a.md': entry(), 'commands/b.md': entry() });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      const plan = planSharedLinkDeletions({ projects: {} });
      expect(plan).toHaveLength(1);
      expect(plan[0]?.name).toBe('commands');
      expect(plan[0]?.repoPath).toBe(join(sharedDir, 'commands', 'a.md'));

      const removed = applySharedLinkDeletions({ projects: {} }, TS);
      expect(existsSync(join(sharedDir, 'commands', 'a.md'))).toBe(false);
      expect(readFileSync(join(sharedDir, 'commands', 'b.md'), 'utf8')).toBe('# b\n');
      // Recoverable from the same timestamped cache the rest of the pull uses.
      expect(
        readFileSync(join(cacheDir, 'backup', TS, 'repo', 'shared', 'commands', 'a.md'), 'utf8'),
      ).toBe('# a\n');
      expect(removed).toHaveLength(1);
      expect(removed[0]?.repoPath).toBe(join(sharedDir, 'commands', 'a.md'));
    });

    it('gates per name: a baselined name propagates while an unbaselined one does not', async () => {
      mkdirSync(join(claudeDir, 'rules'), { recursive: true });
      mkdirSync(join(sharedDir, 'rules'), { recursive: true });
      seedSynced('commands/a.md', '# a\n');
      seedSynced('rules/r.md', '# r\n');
      // Only `commands` was ever recorded. `rules` is present in the repo but
      // this host has no record of having received it.
      plantBaseline({ 'commands/a.md': entry() });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      rmSync(join(claudeDir, 'rules', 'r.md'), { force: true });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toHaveLength(1);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(existsSync(join(sharedDir, 'commands', 'a.md'))).toBe(false);
      expect(readFileSync(join(sharedDir, 'rules', 'r.md'), 'utf8')).toBe('# r\n');
    });

    it('plans nothing for a shared name whose local path is missing entirely', async () => {
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/a.md': entry() });
      // A whole missing directory is an unmounted drive, a rename, or an
      // interrupted pull, not a deletion; treating it as one would empty the repo.
      rmSync(join(claudeDir, 'commands'), { recursive: true, force: true });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('propagates from a directory that exists but was emptied', async () => {
      // The counterpart to the case above, and what posix already does: the
      // directory is there, its contents are genuinely gone.
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/a.md': entry() });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      stubPlatform('win32');
      const { applySharedLinkDeletions } = await import('./links.deletions.ts');
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(existsSync(join(sharedDir, 'commands', 'a.md'))).toBe(false);
    });

    it('plans nothing for a name the user has since dropped from sharedDirs', async () => {
      mkdirSync(join(claudeDir, 'extra'), { recursive: true });
      mkdirSync(join(sharedDir, 'extra'), { recursive: true });
      seedSynced('extra/e.md', '# e\n');
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'extra/e.md': entry() });
      rmSync(join(claudeDir, 'extra', 'e.md'), { force: true });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      // `extra` is no longer in sharedDirs, so its old entries must not be acted on.
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched({ projects: {} }, { 'extra/e.md': '# e\n' });
    });

    it('never removes a denied basename injected into a hand-written baseline', async () => {
      seedSynced('commands/settings.local.json', '{}\n');
      plantBaseline({ 'commands/settings.local.json': entry() });
      rmSync(join(claudeDir, 'commands', 'settings.local.json'), { force: true });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched({ projects: {} }, { 'commands/settings.local.json': '{}\n' });
    });

    it('plans nothing when the repo counterpart is already gone', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      plantBaseline({ 'commands/gone.md': entry() });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      expect(() => applySharedLinkDeletions({ projects: {} }, TS)).not.toThrow();
    });
  });

  describe('containment: a baseline key cannot direct a removal out of shared/', () => {
    /** Plant a file outside `shared/` that an escaping key would target. */
    function plantOutsider(): string {
      const outside = join(testHome, 'claude-nomad', 'outside.txt');
      writeFileSync(outside, '# not yours\n');
      return outside;
    }

    it('discards a key whose parent segments escape the shared directory', async () => {
      const outside = plantOutsider();
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/../../outside.txt': entry() });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(readFileSync(outside, 'utf8')).toBe('# not yours\n');
    });

    it('discards a key that resolves to the shared directory itself', async () => {
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/..': entry() });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('discards a key that resolves to the shared directory parent', async () => {
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/../..': entry() });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('discards a key that redirects at a sibling shared name inside shared/', async () => {
      // The key passes the per-name gate on `commands` and never leaves
      // `shared/`, so anchoring containment on the shared root alone would have
      // let it delete a file under `rules` whose local copy is present and
      // which was never in the deleted set at all.
      mkdirSync(join(claudeDir, 'rules'), { recursive: true });
      mkdirSync(join(sharedDir, 'rules'), { recursive: true });
      seedSynced('commands/a.md', '# a\n');
      seedSynced('rules/keep.md', '# keep\n');
      plantBaseline({ 'commands/../rules/keep.md': entry() });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(readFileSync(join(sharedDir, 'rules', 'keep.md'), 'utf8')).toBe('# keep\n');
    });

    it('discards a key that names the shared name directory itself', async () => {
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ commands: entry() });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('discards an in-bounds key carrying a dot, empty, or parent segment', async () => {
      // Each of these resolves back inside `shared/commands`, so containment
      // alone accepts them; rejecting the key SHAPE is what keeps the reported
      // local path describing the same file as the repo path.
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({
        'commands/./a.md': entry(),
        'commands//a.md': entry(),
        'commands/sub/../a.md': entry(),
      });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      await expectRepoUntouched();
    });

    it('never removes through a denied segment above the basename', async () => {
      // The walk applies the deny predicate at every depth, so a key with a
      // denied intermediate segment could only come from a hand-written record.
      mkdirSync(join(sharedDir, 'commands', 'settings.local.json'), { recursive: true });
      writeFileSync(join(sharedDir, 'commands', 'settings.local.json', 'note.md'), '# note\n');
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/settings.local.json/note.md': entry() });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(
        readFileSync(join(sharedDir, 'commands', 'settings.local.json', 'note.md'), 'utf8'),
      ).toBe('# note\n');
    });

    it('still propagates a sibling name that merely begins with two dots', async () => {
      // The escape test lands on a path-segment boundary, so `..config` is an
      // ordinary name and not a parent reference.
      mkdirSync(join(claudeDir, '..config'), { recursive: true });
      mkdirSync(join(sharedDir, '..config'), { recursive: true });
      seedSynced(join('..config', 'note.md'), '# note\n');
      plantBaseline({ '..config/note.md': entry() });
      rmSync(join(claudeDir, '..config', 'note.md'), { force: true });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      const map = { projects: {}, sharedDirs: ['..config'] };
      expect(planSharedLinkDeletions(map)).toHaveLength(1);
      applySharedLinkDeletions(map, TS);
      expect(existsSync(join(sharedDir, '..config', 'note.md'))).toBe(false);
    });
  });

  describe('an unreadable local path is not a deletion', () => {
    it.skipIf(isWin)('plans nothing beneath a shared name that is now a live symlink', async () => {
      // The baseline was recorded when the name was a real copy; the path has
      // since become a symlink into the repo, so the walk cannot record what is
      // under it. Reading that as a mass deletion would empty the user's own
      // live config, since the link points straight at it.
      mkdirSync(join(sharedDir, 'rules'), { recursive: true });
      writeFileSync(join(sharedDir, 'rules', 'a.md'), '# a\n');
      writeFileSync(join(sharedDir, 'rules', 'b.md'), '# b\n');
      symlinkSync(join(sharedDir, 'rules'), join(claudeDir, 'rules'));
      plantBaseline({ 'rules/a.md': entry(), 'rules/b.md': entry() });
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(readFileSync(join(sharedDir, 'rules', 'a.md'), 'utf8')).toBe('# a\n');
      expect(readFileSync(join(sharedDir, 'rules', 'b.md'), 'utf8')).toBe('# b\n');
    });

    it.skipIf(isWin)('plans nothing beneath a subdirectory it cannot list', async () => {
      // An antivirus lock, an EPERM, or a cloud-storage placeholder makes a
      // directory transiently unlistable. Its files are still there.
      seedSynced('commands/top.md', '# top\n');
      mkdirSync(join(claudeDir, 'commands', 'sub'), { recursive: true });
      mkdirSync(join(sharedDir, 'commands', 'sub'), { recursive: true });
      seedSynced(join('commands', 'sub', 'a.md'), '# a\n');
      seedSynced(join('commands', 'sub', 'b.md'), '# b\n');
      plantBaseline({
        'commands/top.md': entry(),
        'commands/sub/a.md': entry(),
        'commands/sub/b.md': entry(),
      });
      const locked = join(claudeDir, 'commands', 'sub');
      chmodSync(locked, 0o000);
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      try {
        expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
        applySharedLinkDeletions({ projects: {} }, TS);
        expect(readFileSync(join(sharedDir, 'commands', 'sub', 'a.md'), 'utf8')).toBe('# a\n');
        expect(readFileSync(join(sharedDir, 'commands', 'sub', 'b.md'), 'utf8')).toBe('# b\n');
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it('still propagates a sibling whose name merely starts with a declined name', async () => {
      // The declined-path test lands on a path-segment boundary, so declining
      // `commands/sub` must not also swallow `commands/subtitle.md`.
      mkdirSync(join(sharedDir, 'commands', 'sub'), { recursive: true });
      writeFileSync(join(sharedDir, 'commands', 'sub', 'a.md'), '# a\n');
      seedSynced('commands/subtitle.md', '# subtitle\n');
      symlinkSync(join(sharedDir, 'commands', 'sub'), join(claudeDir, 'commands', 'sub'));
      plantBaseline({ 'commands/sub/a.md': entry(), 'commands/subtitle.md': entry() });
      rmSync(join(claudeDir, 'commands', 'subtitle.md'), { force: true });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      const plan = planSharedLinkDeletions({ projects: {} });
      expect(plan.map((e) => e.repoPath)).toEqual([join(sharedDir, 'commands', 'subtitle.md')]);
    });
  });

  describe('case folding: a rename is not a deletion', () => {
    it('plans nothing for a rename that changes only the casing', async () => {
      // NTFS is case-insensitive, so the repo path the old key resolves to is
      // the file the mirror wrote moments earlier under the new casing.
      seedSynced('commands/Foo.md', '# foo\n');
      plantBaseline({ 'commands/Foo.md': entry() });
      rmSync(join(claudeDir, 'commands', 'Foo.md'), { force: true });
      writeFileSync(join(claudeDir, 'commands', 'foo.md'), '# foo\n');
      stubPlatform('win32');
      const { applySharedLinkDeletions, planSharedLinkDeletions } =
        await import('./links.deletions.ts');
      expect(planSharedLinkDeletions({ projects: {} })).toEqual([]);
      applySharedLinkDeletions({ projects: {} }, TS);
      expect(readFileSync(join(sharedDir, 'commands', 'Foo.md'), 'utf8')).toBe('# foo\n');
    });
  });

  describe('applying: one bad entry cannot cancel the rest', () => {
    it('skips a repo path that is a directory and still applies the entries after it', async () => {
      // A type change another host pushed: a file locally, a directory in the
      // repo. A non-recursive removal cannot act on it, and raising would have
      // abandoned every removal planned after it.
      seedSynced('commands/a.md', '# a\n');
      seedSynced('commands/b.md', '# b\n');
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      rmSync(join(claudeDir, 'commands', 'b.md'), { force: true });
      rmSync(join(sharedDir, 'commands', 'a.md'), { force: true });
      mkdirSync(join(sharedDir, 'commands', 'a.md'), { recursive: true });
      plantBaseline({ 'commands/a.md': entry(), 'commands/b.md': entry() });
      stubPlatform('win32');
      const { applySharedLinkDeletions } = await import('./links.deletions.ts');
      let removed: { repoPath: string }[] = [];
      expect(() => {
        removed = applySharedLinkDeletions({ projects: {} }, TS);
      }).not.toThrow();
      expect(existsSync(join(sharedDir, 'commands', 'a.md'))).toBe(true);
      expect(existsSync(join(sharedDir, 'commands', 'b.md'))).toBe(false);
      // Only the entry that was actually removed is in the return.
      expect(removed.map((e) => e.repoPath)).toEqual([join(sharedDir, 'commands', 'b.md')]);
    });

    it.skipIf(isWin)('warns and continues when a repo file cannot be removed', async () => {
      seedSynced('commands/a.md', '# a\n');
      plantBaseline({ 'commands/a.md': entry() });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      // A read-only repo directory leaves the file readable (so it is planned
      // and snapshotted) but makes the unlink itself fail.
      chmodSync(join(sharedDir, 'commands'), 0o500);
      stubPlatform('win32');
      const { applySharedLinkDeletions } = await import('./links.deletions.ts');
      try {
        let removed: unknown[] = [];
        expect(() => {
          removed = applySharedLinkDeletions({ projects: {} }, TS);
        }).not.toThrow();
        expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('could not remove');
        expect(readFileSync(join(sharedDir, 'commands', 'a.md'), 'utf8')).toBe('# a\n');
        expect(removed).toEqual([]);
      } finally {
        chmodSync(join(sharedDir, 'commands'), 0o700);
      }
    });
  });
});
