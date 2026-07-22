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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { warnGlyph } from './color.ts';

/** Shape of the section reportCommittedMemory appends rows to (mirrors DoctorSection). */
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
 * `reportCommittedMemory` / `buildMemoryScanTree` coverage. `buildMemoryScanTree`
 * now sources from the sync repo's committed `HEAD` (via `git ls-tree` +
 * `git cat-file`), so every fixture below is written to disk AND committed
 * with `gitInit`/`commitAll` (real hermetic git repos, not mocks) before the
 * function under test runs. `scanStagedTree` (`./push-gitleaks.ts`) is still
 * mocked so every case controls the scan outcome directly without needing a
 * real gitleaks binary.
 */
describe('commands.doctor.check-shared.memory', () => {
  let testHome: string;
  let repo: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNoColor = process.env.NO_COLOR;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-memory-'));
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

  function writeMemoryFile(logical: string, filename: string, content: string): void {
    const dir = join(repo, 'shared', 'projects', logical, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  it('buildMemoryScanTree returns staged 0 (not incomplete) when repoHome is not a git repo', async () => {
    mkdirSync(repo, { recursive: true });
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    expect(buildMemoryScanTree(join(testHome, 'tmp-scan'))).toEqual({
      staged: 0,
      incomplete: false,
    });
  });

  it('buildMemoryScanTree returns staged 0 (not incomplete) when the repo is a git repo with no HEAD (no commits)', async () => {
    gitInit(repo);
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    expect(buildMemoryScanTree(join(testHome, 'tmp-scan'))).toEqual({
      staged: 0,
      incomplete: false,
    });
  });

  it('buildMemoryScanTree returns staged 0 (not incomplete) when shared/projects is absent from HEAD', async () => {
    gitInit(repo);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    commitAll(repo);
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    expect(buildMemoryScanTree(join(testHome, 'tmp-scan'))).toEqual({
      staged: 0,
      incomplete: false,
    });
  });

  it('buildMemoryScanTree copies each committed logical memory/*.md and returns the distinct logical count', async () => {
    writeMemoryFile('foo', 'notes.md', 'hello\n');
    writeMemoryFile('bar', 'notes.md', 'world\n');
    gitInit(repo);
    commitAll(repo);
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildMemoryScanTree(tmpRoot)).toEqual({ staged: 2, incomplete: false });
    const fooCopy = join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'notes.md');
    const barCopy = join(tmpRoot, 'shared', 'projects', 'bar', 'memory', 'notes.md');
    expect(readFileSync(fooCopy, 'utf8')).toBe('hello\n');
    expect(readFileSync(barCopy, 'utf8')).toBe('world\n');
  });

  it('skips a nested memory/<sub>/x.md and a non-.md file under memory/ (flat-.md filter)', async () => {
    writeMemoryFile('foo', 'notes.md', 'flat\n');
    mkdirSync(join(repo, 'shared', 'projects', 'foo', 'memory', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'projects', 'foo', 'memory', 'sub', 'nested.md'), 'no\n');
    writeFileSync(join(repo, 'shared', 'projects', 'foo', 'memory', 'notes.txt'), 'no\n');
    gitInit(repo);
    commitAll(repo);
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildMemoryScanTree(tmpRoot)).toEqual({ staged: 1, incomplete: false });
    expect(existsSync(join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'notes.md'))).toBe(true);
    expect(
      existsSync(join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'sub', 'nested.md')),
    ).toBe(false);
    expect(existsSync(join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'notes.txt'))).toBe(
      false,
    );
  });

  it('a dirty working-tree edit or delete of a committed memory file does not change results (HEAD-sourced regression)', async () => {
    writeMemoryFile('foo', 'a.md', 'A1\n');
    writeMemoryFile('foo', 'b.md', 'B1\n');
    gitInit(repo);
    commitAll(repo);

    // Dirty the working tree AFTER the commit: edit one file, delete the other.
    // Neither mutation is committed.
    writeFileSync(join(repo, 'shared', 'projects', 'foo', 'memory', 'a.md'), 'DIRTY-EDIT\n');
    rmSync(join(repo, 'shared', 'projects', 'foo', 'memory', 'b.md'));

    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildMemoryScanTree(tmpRoot)).toEqual({ staged: 1, incomplete: false });
    const aCopy = join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'a.md');
    const bCopy = join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'b.md');
    expect(readFileSync(aCopy, 'utf8')).toBe('A1\n');
    expect(readFileSync(bCopy, 'utf8')).toBe('B1\n');
  });

  it('flags the build incomplete (fail-safe) when a git cat-file blob read fails, staging the rest', async () => {
    writeMemoryFile('foo', 'a.md', 'aaa\n');
    writeMemoryFile('foo', 'b.md', 'bbb\n');
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
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildMemoryScanTree(tmpRoot)).toEqual({ staged: 1, incomplete: true });
    expect(existsSync(join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'b.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'a.md'))).toBe(false);
  });

  it('reportCommittedMemory emits nothing when zero logicals are staged', async () => {
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN-skip (never a clean pass) when blob materialization is incomplete', async () => {
    // A committed blob that cannot be read might be the only leaking file, so
    // the advisory must fail safe: WARN-skip, not silently scan a subset.
    writeMemoryFile('foo', 'a.md', 'aaa\n');
    writeMemoryFile('foo', 'b.md', 'bbb\n');
    gitInit(repo);
    commitAll(repo);
    let scanCalled = false;
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn(() => {
          scanCalled = true;
          return [];
        }),
      };
    });
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(scanCalled).toBe(false);
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(section.items[0]).toContain('could not read every committed memory blob');
    expect(process.exitCode).toBe(0);
  });

  it('scans the temp copy, never repoHome() directly', async () => {
    writeMemoryFile('foo', 'notes.md', 'hello\n');
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(capturedDir).not.toBe(repo);
    expect(capturedDir).toContain('check-shared-memory-tree-');
  });

  it.skipIf(process.platform === 'win32')(
    'creates the temp scan tree owner-only (0o700) so committed secrets are not world-readable',
    async () => {
      writeMemoryFile('foo', 'notes.md', 'hello\n');
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
      const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
      const section: Section = { header: 'Shared scan', items: [] };
      reportCommittedMemory(section);
      expect(capturedMode).toBe(0o700);
    },
  );

  it('emits a WARN row per finding naming File + RuleID, never the matched secret, and leaves exitCode untouched', async () => {
    writeMemoryFile('foo', 'notes.md', 'secret\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn(() => [
          {
            RuleID: 'generic-api-key',
            File: 'shared/projects/foo/memory/notes.md',
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    const rows = section.items.join('\n');
    expect(rows).toContain(warnGlyph);
    expect(rows).toContain('generic-api-key');
    expect(rows).toContain('shared/projects/foo/memory/notes.md');
    expect(rows).not.toContain('THE-REAL-SECRET-VALUE');
    expect(rows).toContain('Redact');
    expect(process.exitCode).toBe(0);
  });

  it('emits nothing when the scan returns a clean (empty) findings array', async () => {
    writeMemoryFile('foo', 'notes.md', 'clean\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => []) };
    });
    vi.resetModules();
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('emits a single WARN-skip row when the scan throws, and leaves exitCode untouched', async () => {
    writeMemoryFile('foo', 'notes.md', 'x\n');
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(section.items[0]).toContain('boom');
    expect(process.exitCode).toBe(0);
  });

  it('emits a WARN-skip row when the scan returns a null (unparseable) report', async () => {
    writeMemoryFile('foo', 'notes.md', 'x\n');
    gitInit(repo);
    commitAll(repo);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => null) };
    });
    vi.resetModules();
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => reportCommittedMemory(section)).not.toThrow();
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toContain(warnGlyph);
    expect(section.items[0]).toContain('disk error');
    expect(process.exitCode).toBe(0);
  });

  it('removes the temp tree in a finally on every path, including the throw path', async () => {
    writeMemoryFile('foo', 'notes.md', 'x\n');
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
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(capturedDir).not.toBe('');
    expect(existsSync(capturedDir)).toBe(false);
  });

  it('does not throw when the finally rmSync fails (cleanup failure never aborts the doctor run)', async () => {
    writeMemoryFile('foo', 'notes.md', 'x\n');
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
          if (String(p).includes('check-shared-memory-tree-')) {
            throw new Error('rm boom');
          }
          return actual.rmSync(p, o);
        }),
      };
    });
    vi.resetModules();
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => reportCommittedMemory(section)).not.toThrow();
    // Clean scan (no findings): the swallowed cleanup failure adds no extra row.
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });
});

/**
 * Wiring coverage: `reportCheckShared` (`./commands.doctor.check-shared.ts`)
 * must call `reportCommittedMemory` on every gitleaks-ready path, including
 * the `staged === 0` local-preview early return (proving the advisory is not
 * a local-preview-only add-on: a committed memory secret can originate from
 * any host, not just the one running `doctor`). Mocks `node:child_process`
 * for the gitleaks `version` probe (forwarding real `git` invocations through
 * so `buildMemoryScanTree`'s HEAD-sourced read still works) so
 * `ensureGitleaksReady` passes, and `./push-gitleaks.ts`'s `scanStagedTree`
 * distinguishing the local-preview temp tree (`check-shared-tree-`) from the
 * committed-memory temp tree (`check-shared-memory-tree-`) by directory name,
 * so each scan can be controlled independently without a real gitleaks binary.
 */
describe('reportCheckShared wiring (committed-memory advisory always runs)', () => {
  let testHome: string;
  let repo: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNoColor = process.env.NO_COLOR;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-wiring-'));
    repo = join(testHome, 'claude-nomad');
    process.env.HOME = testHome;
    process.env.NO_COLOR = '1';
    mkdirSync(join(repo, 'shared'), { recursive: true });
    process.exitCode = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('./push-gitleaks.ts');
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeMemoryFile(logical: string, filename: string, content: string): void {
    const dir = join(repo, 'shared', 'projects', logical, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  function mockGitleaksProbe(): void {
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
            if (bin === 'gitleaks' && (args ?? [])[0] === 'version') return Buffer.from('8.0.0');
            // Forward opts (encoding/stdio/timeout/maxBuffer): buildMemoryScanTree's
            // `git ls-tree`/`git cat-file` calls rely on these, e.g. `encoding: 'utf8'`
            // to get a string back instead of a Buffer.
            return actual.execFileSync(bin, args as string[], opts);
          },
        ),
      };
    });
  }

  it('WARNs on a committed memory secret even when staged === 0 (no local path-map entries)', async () => {
    // No path-map.json written: the local preview short-circuits to a clean
    // "0 project(s)" row without ever calling scanStagedTree. The advisory
    // must still run and WARN on the committed memory secret.
    writeMemoryFile('foo', 'notes.md', 'secret\n');
    gitInit(repo);
    commitAll(repo);
    mockGitleaksProbe();
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((dir: string) =>
          dir.includes('check-shared-memory-tree-')
            ? [
                {
                  RuleID: 'generic-api-key',
                  File: 'shared/projects/foo/memory/notes.md',
                  StartLine: 1,
                  StartColumn: 1,
                  EndColumn: 10,
                  Match: 'THE-REAL-SECRET-VALUE',
                  Fingerprint: 'fp1',
                },
              ]
            : [],
        ),
      };
    });
    vi.resetModules();

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain(warnGlyph);
    expect(rows).toContain('shared/projects/foo/memory/notes.md');
    expect(process.exitCode).toBe(0);
  });

  it('adds no advisory row on a --check-shared run with no committed memory secret', async () => {
    writeMemoryFile('foo', 'notes.md', 'clean\n');
    gitInit(repo);
    commitAll(repo);
    mockGitleaksProbe();
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<PushGitleaksModule>();
      return { ...actual, scanStagedTree: vi.fn(() => []) };
    });
    vi.resetModules();

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(warnGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});
