import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubPlatform } from './test-helpers.platform.ts';

/**
 * Real platform of the machine running the suite, restored in `afterEach`.
 * Every test here stubs `process.platform` before importing the module under
 * test, so leaving a stub in place would leak into unrelated files.
 */
const realPlatform = process.platform;

/**
 * Permission-based failure injection (an unreadable file or directory) is a
 * no-op on Windows, where `chmod` does not restrict access. Those cases are the
 * only ones skipped there; the branch they cover is counted on the posix leg.
 */
const isWin = realPlatform === 'win32';

describe('shared-links baseline', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let claudeDir: string;
  let cacheDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-baseline-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    // repoHome() prefers NOMAD_REPO over the $HOME fallback these fixtures
    // assume, so an ambient export would aim the assertions at a real checkout.
    delete process.env.NOMAD_REPO;
    claudeDir = join(testHome, '.claude');
    cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
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

  /** Absolute path of this host's baseline file inside the sandbox. */
  function baselineFile(): string {
    return join(cacheDir, 'shared-baseline-test-host.json');
  }

  /**
   * Write raw bytes to the baseline path, bypassing the writer entirely. The
   * negative cases exist precisely to prove the reader survives a file it did
   * not produce.
   */
  function plantRawBaseline(raw: string): void {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(baselineFile(), raw);
  }

  describe('readSharedBaseline', () => {
    it('returns null when no baseline has ever been written', async () => {
      stubPlatform('win32');
      const { readSharedBaseline } = await import('./links.baseline.ts');
      expect(readSharedBaseline()).toBeNull();
    });

    it('returns null on malformed JSON without throwing', async () => {
      plantRawBaseline('{ not json\n');
      stubPlatform('win32');
      const { readSharedBaseline } = await import('./links.baseline.ts');
      expect(() => readSharedBaseline()).not.toThrow();
      expect(readSharedBaseline()).toBeNull();
    });

    it('returns null on valid JSON of the wrong shape', async () => {
      plantRawBaseline(JSON.stringify({ files: 'not an object' }) + '\n');
      stubPlatform('win32');
      const { readSharedBaseline } = await import('./links.baseline.ts');
      expect(readSharedBaseline()).toBeNull();
    });

    it('returns null for a shape-valid record written by a different producer', async () => {
      // A push manifest satisfies the same structural guard (it checks only that
      // scannerVersion and configHash are strings, never their values), so
      // without the producer tag a copied or mis-resolved manifest would parse
      // cleanly and authorize deletions from a record of a different tree.
      plantRawBaseline(
        JSON.stringify({
          schema: 1,
          scannerVersion: '8.30.1',
          configHash: 'deadbeef',
          files: { 'commands/a.md': { size: 1, mtime: 1, hash: 'x' } },
        }) + '\n',
      );
      stubPlatform('win32');
      const { readSharedBaseline } = await import('./links.baseline.ts');
      expect(readSharedBaseline()).toBeNull();
    });

    it('round-trips a baseline the writer produced', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      stubPlatform('win32');
      const { readSharedBaseline, writeSharedBaseline, SHARED_BASELINE_KIND } =
        await import('./links.baseline.ts');
      writeSharedBaseline({ projects: {} });
      const parsed = readSharedBaseline();
      expect(parsed?.scannerVersion).toBe(SHARED_BASELINE_KIND);
      expect(Object.keys(parsed?.files ?? {})).toEqual(['commands/a.md']);
    });
  });

  describe('enumerateLocalSharedFiles', () => {
    it('keys every file by its config-home-relative POSIX path', async () => {
      mkdirSync(join(claudeDir, 'commands', 'nested'), { recursive: true });
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      writeFileSync(join(claudeDir, 'commands', 'nested', 'b.md'), '# b\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# root file entry\n');
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      expect(Object.keys(enumerateLocalSharedFiles({ projects: {} })).sort()).toEqual([
        'CLAUDE.md',
        'commands/a.md',
        'commands/nested/b.md',
      ]);
    });

    it('records nothing for a shared name this host does not have', async () => {
      // rules/ and my-statusline.cjs are absent from the sandbox entirely.
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      expect(enumerateLocalSharedFiles({ projects: {} })).toEqual({});
    });

    it.skipIf(isWin)('skips a shared name that is still a live symlink', async () => {
      const target = join(testHome, 'claude-nomad', 'shared', 'rules');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'via-symlink.md'), '# linked\n');
      symlinkSync(target, join(claudeDir, 'rules'));
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      // Recording a symlinked tree would let a later un-symlinking read as a
      // mass deletion of everything it contained.
      expect(enumerateLocalSharedFiles({ projects: {} })).toEqual({});
    });

    it('never records a denied basename nested inside a shared directory', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{}\n');
      writeFileSync(join(claudeDir, 'commands', '.credentials.json'), '{}\n');
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      expect(Object.keys(enumerateLocalSharedFiles({ projects: {} }))).toEqual(['commands/a.md']);
    });

    it('never records a configured shared name the deny set rejects', async () => {
      // `credentials` is credential-shaped, so `allSharedLinks` now drops it
      // before this walk even sees it (the sharedDirs guard's own reason,
      // not the deny set). The deny set stays as a second, redundant gate.
      mkdirSync(join(claudeDir, 'credentials'), { recursive: true });
      writeFileSync(join(claudeDir, 'credentials', 'token.txt'), 'secret\n');
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      expect(enumerateLocalSharedFiles({ projects: {}, sharedDirs: ['credentials'] })).toEqual({});
    });

    it.skipIf(isWin)('skips an unlistable subdirectory instead of failing', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      const locked = join(claudeDir, 'commands', 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'b.md'), '# b\n');
      chmodSync(locked, 0o000);
      stubPlatform('win32');
      const { enumerateLocalSharedFiles } = await import('./links.baseline.ts');
      try {
        expect(Object.keys(enumerateLocalSharedFiles({ projects: {} }))).toEqual(['commands/a.md']);
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });

  describe('enumerateLocalSharedScan', () => {
    it('declines nothing when every configured name is readable or simply absent', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      stubPlatform('win32');
      const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
      const scan = enumerateLocalSharedScan({ projects: {} });
      // A genuinely absent name is the deletion signal the planner acts on, so
      // it must never be reported as a path the walk declined to read.
      expect(scan.declined).toEqual([]);
      expect(Object.keys(scan.files)).toEqual(['commands/a.md']);
    });

    it.skipIf(isWin)('declines a shared name that is still a live symlink', async () => {
      const target = join(testHome, 'claude-nomad', 'shared', 'rules');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'via-symlink.md'), '# linked\n');
      symlinkSync(target, join(claudeDir, 'rules'));
      stubPlatform('win32');
      const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
      expect(enumerateLocalSharedScan({ projects: {} }).declined).toEqual(['rules']);
    });

    it.skipIf(isWin)('declines a subdirectory it cannot list', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      const locked = join(claudeDir, 'commands', 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'b.md'), '# b\n');
      chmodSync(locked, 0o000);
      stubPlatform('win32');
      const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
      try {
        const scan = enumerateLocalSharedScan({ projects: {} });
        expect(scan.declined).toEqual(['commands/locked']);
        expect(Object.keys(scan.files)).toEqual(['commands/a.md']);
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it.skipIf(isWin)('declines an entry it cannot stat at all', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      // An unreadable parent makes lstat on every child throw EACCES, which
      // `throwIfNoEntry: false` does not suppress (it covers ENOENT only).
      chmodSync(claudeDir, 0o000);
      stubPlatform('win32');
      const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
      try {
        const scan = enumerateLocalSharedScan({ projects: {} });
        expect(scan.files).toEqual({});
        expect(scan.declined).toContain('commands');
      } finally {
        chmodSync(claudeDir, 0o700);
      }
    });

    it('declines a nested basename the deny set rejects, and never walks a credential-shaped configured name at all', async () => {
      // `credentials` is now excluded by `allSharedLinks` itself (the
      // sharedDirs guard's secret-shaped reason), so it never reaches this
      // walk and is absent from both `files` and `declined`.
      mkdirSync(join(claudeDir, 'credentials'), { recursive: true });
      writeFileSync(join(claudeDir, 'credentials', 'token.txt'), 'secret\n');
      writeFileSync(join(claudeDir, 'commands', 'settings.local.json'), '{}\n');
      stubPlatform('win32');
      const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
      const scan = enumerateLocalSharedScan({ projects: {}, sharedDirs: ['credentials'] });
      expect(scan.files).toEqual({});
      expect(scan.declined).toEqual(['commands/settings.local.json']);
    });

    // Skipped on win32: whether NTFS accepts a basename with a trailing dot
    // through node:fs is unverified on this project's CI, and the
    // platform-independent proof of the underlying predicate already lives
    // in config.test.ts. An ordinary file proves `files` still records what
    // it should; `declined` (not a silent absence) is what stops a later
    // read of that absence from being taken as a user deletion. No
    // `stubPlatform('win32')` here: `enumerateLocalSharedScan` has no
    // platform branch, so stubbing it (as the sibling tests above do for
    // `writeSharedBaseline`, which does branch) would only misstate what
    // this test actually exercises.
    it.skipIf(isWin)(
      'declines a nested trailing-dot credential name instead of recording it',
      async () => {
        writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
        writeFileSync(join(claudeDir, 'commands', '.env.'), 'TOKEN=secret\n');
        const { enumerateLocalSharedScan } = await import('./links.baseline.ts');
        const scan = enumerateLocalSharedScan({ projects: {} });
        expect(Object.keys(scan.files)).toEqual(['commands/a.md']);
        expect(scan.declined).toEqual(['commands/.env.']);
      },
    );

    // Ground truth instead of an assumption: this repo has already shipped a
    // win32 premise (the Phase 72/73 sharedDirs trailing-dot alias rule) that
    // survived five-plus review passes before the first real Windows CI run
    // falsified it. Runs ONLY on win32 (CI has that runner); records whether
    // `.env.` survives `node:fs` on this host rather than skipping the
    // platform the trailing-dot threat model is about.
    it.runIf(process.platform === 'win32')(
      'records whether NTFS preserves a trailing-dot basename',
      () => {
        writeFileSync(join(claudeDir, 'commands', '.env.'), 'TOKEN=secret\n');
        // Either the name survives on disk (the predicate must catch it, and
        // the skipped test above should be un-skipped and re-verified on
        // win32) or it normalized to `.env` (already caught pre-change; the
        // trailing-dot class is unreachable through node:fs on this host).
        const survived = existsSync(join(claudeDir, 'commands', '.env.'));
        const entries = readdirSync(join(claudeDir, 'commands'));
        // Printed so the answer is readable in the Windows job log. A green run
        // alone cannot say which way it went, and unrecorded ground truth is
        // how the falsified premise above survived in the first place.
        console.log(`[win32 probe] trailing-dot basename on disk: ${JSON.stringify(entries)}`);
        expect(entries).toContain(survived ? '.env.' : '.env');
      },
    );
  });

  describe('buildSharedBaseline', () => {
    it('records size, mtime and hash for each enumerated file', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      stubPlatform('win32');
      const { buildSharedBaseline } = await import('./links.baseline.ts');
      const entry = buildSharedBaseline({ projects: {} }).files['commands/a.md'];
      expect(entry?.size).toBe(4);
      expect(entry?.mtime).toBeGreaterThan(0);
      expect(entry?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it.skipIf(isWin)('drops a file whose hash cannot be read rather than failing', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      const locked = join(claudeDir, 'commands', 'locked.md');
      writeFileSync(locked, '# locked\n');
      chmodSync(locked, 0o000);
      stubPlatform('win32');
      const { buildSharedBaseline } = await import('./links.baseline.ts');
      try {
        // Under-recording authorizes nothing, which is the safe direction; a
        // throw here would fail a pull that had already succeeded.
        expect(Object.keys(buildSharedBaseline({ projects: {} }).files)).toEqual(['commands/a.md']);
      } finally {
        chmodSync(locked, 0o600);
      }
    });
  });

  describe('writeSharedBaseline', () => {
    it('writes nothing at all on a posix platform', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      stubPlatform('linux');
      const { readSharedBaseline, writeSharedBaseline } = await import('./links.baseline.ts');
      writeSharedBaseline({ projects: {} });
      expect(readSharedBaseline()).toBeNull();
    });

    it('warns and leaves the previous record in place when the write fails', async () => {
      writeFileSync(join(claudeDir, 'commands', 'a.md'), '# a\n');
      // A plain file where the cache directory belongs makes the parent mkdir
      // throw, standing in for any write failure (full disk, EPERM).
      mkdirSync(join(testHome, '.cache'), { recursive: true });
      writeFileSync(cacheDir, 'not a dir\n');
      stubPlatform('win32');
      const { writeSharedBaseline } = await import('./links.baseline.ts');
      // This runs after the shared-link apply has already rewritten the user's
      // config directory, so a throw would fail a pull that in fact succeeded.
      expect(() => writeSharedBaseline({ projects: {} })).not.toThrow();
      expect(vi.mocked(console.error).mock.calls.join('\n')).toContain('shared-config baseline');
      expect(readFileSync(cacheDir, 'utf8')).toBe('not a dir\n');
    });
  });
});
