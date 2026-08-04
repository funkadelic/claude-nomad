import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
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
  ): Promise<void> {
    const { applySharedLinkDeletions } = await import('./links.deletions.ts');
    applySharedLinkDeletions(map, TS);
    for (const [rel, content] of Object.entries(expected)) {
      expect(readFileSync(join(sharedDir, rel), 'utf8')).toBe(content);
    }
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
      await expectRepoUntouched();
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

      applySharedLinkDeletions({ projects: {} }, TS);
      expect(existsSync(join(sharedDir, 'commands', 'a.md'))).toBe(false);
      expect(readFileSync(join(sharedDir, 'commands', 'b.md'), 'utf8')).toBe('# b\n');
      // Recoverable from the same timestamped cache the rest of the pull uses.
      expect(
        readFileSync(join(cacheDir, 'backup', TS, 'repo', 'shared', 'commands', 'a.md'), 'utf8'),
      ).toBe('# a\n');
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

  describe('resilience', () => {
    it.skipIf(isWin)('plans through a file whose hash cannot be read', async () => {
      seedSynced('commands/a.md', '# a\n');
      seedSynced('commands/b.md', '# b\n');
      // Same size as the record but a moved mtime is exactly the case where the
      // diff reaches for a hash; the file is unreadable, so hashing throws.
      const locked = join(claudeDir, 'commands', 'b.md');
      utimesSync(locked, new Date(0), new Date(0));
      chmodSync(locked, 0o000);
      plantBaseline({
        'commands/a.md': entry(),
        'commands/b.md': { size: 4, mtime: 999999, hash: 'stale' },
      });
      rmSync(join(claudeDir, 'commands', 'a.md'), { force: true });
      stubPlatform('win32');
      const { planSharedLinkDeletions } = await import('./links.deletions.ts');
      try {
        // A file that cannot be read mid-run must not throw out of the pull; the
        // genuine deletion beside it still propagates.
        expect(planSharedLinkDeletions({ projects: {} })).toHaveLength(1);
      } finally {
        chmodSync(locked, 0o600);
      }
    });
  });
});
