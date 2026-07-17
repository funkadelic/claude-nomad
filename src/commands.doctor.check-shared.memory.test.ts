import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * `reportCommittedMemory` / `buildMemoryScanTree` coverage. Mocks
 * `./push-gitleaks.ts`'s `scanStagedTree` (rather than `node:child_process`,
 * the pattern the sibling `check-shared.test.ts` uses for the local-preview
 * scan) so every case controls the scan outcome directly without needing a
 * real gitleaks binary, and can assert on exactly which directory
 * `scanStagedTree` was invoked against.
 */
describe('commands.doctor.check-shared.memory', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNoColor = process.env.NO_COLOR;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-memory-'));
    process.env.HOME = testHome;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./push-gitleaks.ts');
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeMemoryFile(logical: string, filename: string, content: string): void {
    const dir = join(testHome, 'claude-nomad', 'shared', 'projects', logical, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  it('buildMemoryScanTree returns 0 when shared/projects does not exist', async () => {
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    expect(buildMemoryScanTree(join(testHome, 'tmp-scan'))).toBe(0);
  });

  it('buildMemoryScanTree skips a project entry with no memory/ subdir', async () => {
    mkdirSync(join(testHome, 'claude-nomad', 'shared', 'projects', 'nomem'), { recursive: true });
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    expect(buildMemoryScanTree(join(testHome, 'tmp-scan'))).toBe(0);
  });

  it('buildMemoryScanTree copies each logical memory/ dir and returns the staged count', async () => {
    writeMemoryFile('foo', 'notes.md', 'hello\n');
    writeMemoryFile('bar', 'notes.md', 'world\n');
    const { buildMemoryScanTree } = await import('./commands.doctor.check-shared.memory.ts');
    const tmpRoot = join(testHome, 'tmp-scan');
    expect(buildMemoryScanTree(tmpRoot)).toBe(2);
    const copied = join(tmpRoot, 'shared', 'projects', 'foo', 'memory', 'notes.md');
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf8')).toBe('hello\n');
  });

  it('reportCommittedMemory emits nothing when zero logicals are staged', async () => {
    const { reportCommittedMemory } = await import('./commands.doctor.check-shared.memory.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCommittedMemory(section);
    expect(section.items).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('scans the temp copy, never repoHome() directly', async () => {
    writeMemoryFile('foo', 'notes.md', 'hello\n');
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
    expect(capturedDir).not.toBe(join(testHome, 'claude-nomad'));
    expect(capturedDir).toContain('check-shared-memory-tree-');
  });

  it('emits a WARN row per finding naming File + RuleID, never the matched secret, and leaves exitCode untouched', async () => {
    writeMemoryFile('foo', 'notes.md', 'secret\n');
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
    writeMemoryFile('foo', 'notes.md', 'x\n');
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
});

/**
 * Wiring coverage: `reportCheckShared` (`./commands.doctor.check-shared.ts`)
 * must call `reportCommittedMemory` on every gitleaks-ready path, including
 * the `staged === 0` local-preview early return (proving the advisory is not
 * a local-preview-only add-on: a committed memory secret can originate from
 * any host, not just the one running `doctor`). Mocks `node:child_process`
 * (gitleaks `version` probe) so `ensureGitleaksReady` passes, and
 * `./push-gitleaks.ts`'s `scanStagedTree` distinguishing the local-preview
 * temp tree (`check-shared-tree-`) from the committed-memory temp tree
 * (`check-shared-memory-tree-`) by directory name, so each scan can be
 * controlled independently without a real gitleaks binary.
 */
describe('reportCheckShared wiring (committed-memory advisory always runs)', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNoColor = process.env.NO_COLOR;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-wiring-'));
    process.env.HOME = testHome;
    process.env.NO_COLOR = '1';
    mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
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
    const dir = join(testHome, 'claude-nomad', 'shared', 'projects', logical, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  function mockGitleaksProbe(): void {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin === 'gitleaks' && (args ?? [])[0] === 'version') return Buffer.from('8.0.0');
          return actual.execFileSync(bin, args as string[]);
        }),
      };
    });
  }

  it('WARNs on a committed memory secret even when staged === 0 (no local path-map entries)', async () => {
    // No path-map.json written: the local preview short-circuits to a clean
    // "0 project(s)" row without ever calling scanStagedTree. The advisory
    // must still run and WARN on the committed memory secret.
    writeMemoryFile('foo', 'notes.md', 'secret\n');
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
