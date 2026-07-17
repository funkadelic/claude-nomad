import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { warnGlyph } from './color.ts';

/** Shape of the section reportCommittedSkills appends rows to (mirrors DoctorSection). */
type Section = { header: string; items: string[] };

/** Named type alias for `importOriginal`, avoiding an inline `import()` type annotation. */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PushGitleaksModule = typeof import('./push-gitleaks.ts');

/**
 * Initialize a git repo at `repo` (creating the directory if needed). Safe to
 * call on a directory that already has files staged for the first commit.
 *
 * @param repo Absolute path to the repo root.
 */
function gitInit(repo: string): void {
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
}

/**
 * Stage and commit everything currently on disk under `repo` with a fixed
 * throwaway identity (no reliance on the host's global git config).
 *
 * @param repo Absolute path to the repo root.
 * @param message Commit message (defaults to `'fixture'`).
 */
function commitAll(repo: string, message = 'fixture'): void {
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message],
    { stdio: 'ignore' },
  );
}

/**
 * `reportCommittedSkills` / `buildSkillScanTree` coverage. `buildSkillScanTree`
 * sources from the sync repo's committed `HEAD` (via `git ls-tree` + `git
 * cat-file`), so every fixture below is written to disk AND committed with
 * `gitInit`/`commitAll` (real hermetic git repos, not mocks) before the
 * function under test runs. `scanStagedTree` (`./push-gitleaks.ts`) is still
 * mocked so every case controls the scan outcome directly without needing a
 * real gitleaks binary.
 */
describe('commands.doctor.check-shared.skills', () => {
  let testHome: string;
  let repo: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNoColor = process.env.NO_COLOR;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-skills-'));
    repo = join(testHome, 'claude-nomad');
    process.env.HOME = testHome;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeSkillFile(name: string, relPath: string, content: string): void {
    const dest = join(repo, 'shared', 'skills', name, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }

  it('buildSkillScanTree returns 0 when repoHome is not a git repo', async () => {
    mkdirSync(repo, { recursive: true });
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    expect(buildSkillScanTree(join(testHome, 'tmp-scan'))).toBe(0);
  });

  it('buildSkillScanTree returns 0 when the repo is a git repo with no HEAD (no commits)', async () => {
    gitInit(repo);
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    expect(buildSkillScanTree(join(testHome, 'tmp-scan'))).toBe(0);
  });

  it('buildSkillScanTree returns 0 when shared/skills is absent from HEAD', async () => {
    gitInit(repo);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    commitAll(repo);
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    expect(buildSkillScanTree(join(testHome, 'tmp-scan'))).toBe(0);
  });

  it('buildSkillScanTree copies each committed skill file (incl. a nested path) and returns the distinct skill-name count', async () => {
    writeSkillFile('foo', 'SKILL.md', 'hello\n');
    writeSkillFile('foo', 'references/notes.md', 'nested\n');
    writeSkillFile('bar', 'SKILL.md', 'world\n');
    gitInit(repo);
    commitAll(repo);
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildSkillScanTree(tmpRoot)).toBe(2);
    const fooSkill = join(tmpRoot, 'shared', 'skills', 'foo', 'SKILL.md');
    const fooNested = join(tmpRoot, 'shared', 'skills', 'foo', 'references', 'notes.md');
    const barSkill = join(tmpRoot, 'shared', 'skills', 'bar', 'SKILL.md');
    expect(readFileSync(fooSkill, 'utf8')).toBe('hello\n');
    expect(readFileSync(fooNested, 'utf8')).toBe('nested\n');
    expect(readFileSync(barSkill, 'utf8')).toBe('world\n');
  });

  it('skips a gsd-owned skill dir entirely, even with a planted secret', async () => {
    writeSkillFile('gsd-foo', 'SKILL.md', 'secret-content\n');
    writeSkillFile('bar', 'SKILL.md', 'clean\n');
    gitInit(repo);
    commitAll(repo);
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildSkillScanTree(tmpRoot)).toBe(1);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'gsd-foo', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'bar', 'SKILL.md'))).toBe(true);
  });

  it('skips a bare file directly under shared/skills/ with no name/relPath split', async () => {
    mkdirSync(join(repo, 'shared', 'skills'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'skills', 'bare-file.md'), 'no subdir\n');
    writeSkillFile('foo', 'SKILL.md', 'hello\n');
    gitInit(repo);
    commitAll(repo);
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildSkillScanTree(tmpRoot)).toBe(1);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'bare-file.md'))).toBe(false);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'foo', 'SKILL.md'))).toBe(true);
  });

  it('a dirty working-tree edit or delete of a committed skill file does not change results (HEAD-sourced)', async () => {
    writeSkillFile('foo', 'a.md', 'A1\n');
    writeSkillFile('foo', 'b.md', 'B1\n');
    gitInit(repo);
    commitAll(repo);

    writeFileSync(join(repo, 'shared', 'skills', 'foo', 'a.md'), 'DIRTY-EDIT\n');
    rmSync(join(repo, 'shared', 'skills', 'foo', 'b.md'));

    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildSkillScanTree(tmpRoot)).toBe(1);
    const aCopy = join(tmpRoot, 'shared', 'skills', 'foo', 'a.md');
    const bCopy = join(tmpRoot, 'shared', 'skills', 'foo', 'b.md');
    expect(readFileSync(aCopy, 'utf8')).toBe('A1\n');
    expect(readFileSync(bCopy, 'utf8')).toBe('B1\n');
  });

  it('skips a file whose git cat-file blob read fails, continuing with the rest', async () => {
    writeSkillFile('foo', 'a.md', 'aaa\n');
    writeSkillFile('foo', 'b.md', 'bbb\n');
    gitInit(repo);
    commitAll(repo);

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (
            bin: string,
            args?: readonly string[],
            opts?: Parameters<typeof cpModule.execFileSync>[2],
          ) => {
            const a = args ?? [];
            if (
              bin === 'git' &&
              a.includes('cat-file') &&
              a.some((x) => String(x).includes('a.md'))
            ) {
              throw new Error('cat-file boom');
            }
            return actual.execFileSync(bin, a as string[], opts);
          },
        ),
      };
    });
    vi.resetModules();
    const { buildSkillScanTree } = await import('./commands.doctor.check-shared.skills.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildSkillScanTree(tmpRoot)).toBe(1);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'foo', 'b.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'shared', 'skills', 'foo', 'a.md'))).toBe(false);
  });

  it('reportCommittedSkills emits nothing when zero skill names are staged', async () => {
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('scans the temp copy, never repoHome() directly', async () => {
    writeSkillFile('foo', 'SKILL.md', 'hello\n');
    gitInit(repo);
    commitAll(repo);
    let capturedDir = '';
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((dir: string) => {
          capturedDir = dir;
          return [];
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(capturedDir).not.toBe(repo);
    expect(capturedDir).toContain('check-shared-skills-tree-');
  });

  it.skipIf(process.platform === 'win32')(
    'creates the temp scan tree owner-only (0o700) so committed secrets are not world-readable',
    async () => {
      writeSkillFile('foo', 'SKILL.md', 'hello\n');
      gitInit(repo);
      commitAll(repo);
      let capturedMode = -1;
      vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
        const actual = await importOriginal<PushGitleaksModule>();
        return {
          ...actual,
          scanStagedTree: vi.fn((dir: string) => {
            capturedMode = statSync(dir).mode & 0o777;
            return [];
          }),
        };
      });
      vi.resetModules();
      const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
      const section: Section = { header: 'Shared scan', items: [] };
      reportCommittedSkills(section);
      expect(capturedMode).toBe(0o700);
    },
  );

  it('emits a WARN row per finding naming File + RuleID, never the matched secret, and leaves exitCode untouched', async () => {
    writeSkillFile('foo', 'references/notes.md', 'secret\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn(() => [
          {
            RuleID: 'generic-api-key',
            File: 'shared/skills/foo/references/notes.md',
            StartLine: 1,
            StartColumn: 1,
            EndColumn: 10,
            Match: 'THE-REAL-SECRET-VALUE',
            Fingerprint: 'fp1',
          },
        ]),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    const rows = section.items.join('\n');
    expect(rows).toContain(warnGlyph);
    expect(rows).toContain('generic-api-key');
    expect(rows).toContain('shared/skills/foo/references/notes.md');
    expect(rows).not.toContain('THE-REAL-SECRET-VALUE');
    expect(rows).toContain('Redact');
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing when the scan returns a clean (empty) findings array', async () => {
    writeSkillFile('foo', 'SKILL.md', 'clean\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => []) };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('emits a single WARN-skip row when the scan throws, and leaves exitCode untouched', async () => {
    writeSkillFile('foo', 'SKILL.md', 'x\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn(() => {
          throw new Error('boom');
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(section.items[0]).toContain('boom');
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN-skip row when the scan returns a null (unparseable) report', async () => {
    writeSkillFile('foo', 'SKILL.md', 'x\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => null) };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('emits a single WARN-skip row when a failure occurs before the scan (e.g. mkdirSync), never throwing', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        mkdirSync: vi.fn((p: fsModule.PathLike, o?: fsModule.MakeDirectoryOptions) => {
          if (String(p).includes(join('.cache', 'claude-nomad'))) {
            throw Object.assign(new Error('mkdir cache failed: disk error'), { code: 'EIO' });
          }
          return actual.mkdirSync(p, o);
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => reportCommittedSkills(section)).not.toThrow();
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(section.items[0]).toContain('disk error');
    expect(process.exitCode).toBe(0);
  });

  it('removes the temp tree in a finally on every path, including the throw path', async () => {
    writeSkillFile('foo', 'SKILL.md', 'x\n');
    gitInit(repo);
    commitAll(repo);
    let capturedDir = '';
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((dir: string) => {
          capturedDir = dir;
          throw new Error('boom');
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedSkills(section);
    expect(capturedDir).not.toBe('');
    expect(existsSync(capturedDir)).toBe(false);
  });

  it('does not throw when the finally rmSync fails (cleanup failure never aborts the doctor run)', async () => {
    writeSkillFile('foo', 'SKILL.md', 'x\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => []) };
    });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        rmSync: vi.fn((p: fsModule.PathLike, o?: fsModule.RmOptions) => {
          if (String(p).includes('check-shared-skills-tree-')) {
            throw new Error('rm boom');
          }
          return actual.rmSync(p, o);
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedSkills } = await import('./commands.doctor.check-shared.skills.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => reportCommittedSkills(section)).not.toThrow();
    // Clean scan (no findings): the swallowed cleanup failure adds no extra row.
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });
});
