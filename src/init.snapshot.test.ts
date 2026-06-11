import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `snapshotIntoShared`, focusing on the two behavioral survivors
 * from the Phase-46 Stryker sweep:
 *
 * - L30 `statSync(src).isDirectory()` (ConditionalExpression false): routing
 *   source entries as file vs directory. A false mutation routes every entry
 *   through `copyFileSync`, which fails on directories.
 *
 * - L38 `existsSync(gk)` (BooleanLiteral true): removing the `.gitkeep` marker
 *   before `cpSync`. A true mutation always calls `rmSync(gk)` even when the
 *   file does not exist, throwing ENOENT.
 */
describe('snapshotIntoShared: file vs directory routing (L30) and .gitkeep removal (L38)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoHome: string;
  let claudeDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-snapshot-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoHome = join(testHome, 'claude-nomad');
    process.env.NOMAD_REPO = repoHome;
    claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    // Scaffold a minimal repo: shared/<name>/ stubs with .gitkeep for dirs,
    // hosts/ dir for the settings snapshot.
    for (const name of ['agents', 'skills', 'commands', 'rules', 'hooks']) {
      const stubDir = join(repoHome, 'shared', name);
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, '.gitkeep'), '');
    }
    mkdirSync(join(repoHome, 'shared'), { recursive: true });
    mkdirSync(join(repoHome, 'hosts'), { recursive: true });
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
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

  it('copies a directory src via cpSync (not copyFileSync) when isDirectory() is true (L30)', async () => {
    // ~/.claude/skills/ is a directory. snapshotIntoShared must route it through
    // cpSync. A ConditionalExpression-false mutation would call copyFileSync on it,
    // which throws EISDIR (cannot copy a directory with copyFileSync).
    // agents is no longer in SHARED_LINKS (gsd-owned); use skills instead.
    const skillsDir = join(claudeDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# my skill\n');

    const { snapshotIntoShared } = await import('./init.snapshot.ts');
    expect(() => snapshotIntoShared({ projects: {} })).not.toThrow();

    // Verify cpSync wrote the file into shared/skills/.
    expect(readFileSync(join(repoHome, 'shared', 'skills', 'my-skill.md'), 'utf8')).toBe(
      '# my skill\n',
    );
  });

  it('copies a regular file src via copyFileSync (not cpSync) when isDirectory() is false (L30)', async () => {
    // ~/.claude/CLAUDE.md is a regular file. snapshotIntoShared must route it
    // through copyFileSync, not cpSync.
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# my claude\n');
    // Create the shared stub (no .gitkeep for files).
    writeFileSync(join(repoHome, 'shared', 'CLAUDE.md'), '# placeholder\n');

    const { snapshotIntoShared } = await import('./init.snapshot.ts');
    expect(() => snapshotIntoShared({ projects: {} })).not.toThrow();

    expect(readFileSync(join(repoHome, 'shared', 'CLAUDE.md'), 'utf8')).toBe('# my claude\n');
  });

  it('removes .gitkeep before cpSync when it exists (L38: existsSync guard)', async () => {
    // shared/skills/.gitkeep exists (the normal scaffold). snapshotIntoShared
    // must remove it before cpSync so the dst directory is empty. If existsSync
    // were true (BooleanLiteral mutation), rmSync on an absent .gitkeep would throw.
    // agents is no longer in SHARED_LINKS (gsd-owned); use skills instead.
    const skillsDir = join(claudeDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# skill\n');

    const gkPath = join(repoHome, 'shared', 'skills', '.gitkeep');
    expect(existsSync(gkPath)).toBe(true);

    const { snapshotIntoShared } = await import('./init.snapshot.ts');
    expect(() => snapshotIntoShared({ projects: {} })).not.toThrow();

    // .gitkeep was removed; the real content is there now.
    expect(existsSync(gkPath)).toBe(false);
    expect(existsSync(join(repoHome, 'shared', 'skills', 'my-skill.md'))).toBe(true);
  });

  it('does NOT throw when .gitkeep is absent before cpSync (L38: existsSync guard skips rmSync)', async () => {
    // shared/skills/ exists but .gitkeep was already removed (e.g. a re-run
    // after an aborted snapshot). Without the existsSync guard, rmSync would
    // throw ENOENT on the absent .gitkeep. With the guard, rmSync is skipped.
    // agents is no longer in SHARED_LINKS (gsd-owned); use skills instead.
    const skillsDir = join(claudeDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'my-skill.md'), '# skill\n');

    // Remove the .gitkeep manually to simulate the absent case.
    const gkPath = join(repoHome, 'shared', 'skills', '.gitkeep');
    rmSync(gkPath);
    expect(existsSync(gkPath)).toBe(false);

    const { snapshotIntoShared } = await import('./init.snapshot.ts');
    expect(() => snapshotIntoShared({ projects: {} })).not.toThrow();
    expect(existsSync(join(repoHome, 'shared', 'skills', 'my-skill.md'))).toBe(true);
  });
});
