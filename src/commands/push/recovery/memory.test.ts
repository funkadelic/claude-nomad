import {
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

import type * as utilsFsModule from '../../../utils.fs.ts';
import type * as utilsModule from '../../../utils.ts';
import type { PathMap } from '../../../config.ts';
import type { Finding } from '../gitleaks.scan.ts';

/**
 * Unit tests for `src/commands/push/recovery/memory.ts`: the project-level
 * memory-file resolution and redaction seam. Fixtures deliberately mirror the
 * REAL, empirically-observed layout (`memory/` as a flat, project-level
 * sibling of every `<sid>/` subtree, NOT nested inside one), distinguishing
 * this suite from the session-subtree fixtures in
 * `commands/push/recovery/redact.test.ts`.
 */

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    RuleID: overrides.RuleID ?? 'generic-api-key',
    File: overrides.File ?? 'shared/projects/myproject/memory/notes.md',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 1,
    EndColumn: overrides.EndColumn ?? 10,
    Match: overrides.Match ?? 'real-secret-value',
    Fingerprint: overrides.Fingerprint ?? 'fp1',
    Description: overrides.Description,
  };
}

/**
 * Build a fixture: a project-level `memory/*.md` file under a temp
 * CLAUDE_HOME, plus a matching path-map. `memory/` sits directly under the
 * encoded project dir, a SIBLING of any `<sid>/` subtree, not nested inside
 * one.
 */
function makeMemoryFixture(testHome: string): {
  projectsDir: string;
  memoryDir: string;
  memoryPath: string;
  nestedPath: string;
  map: PathMap;
} {
  const claudeHomeDir = join(testHome, '.claude');
  const projectsDir = join(claudeHomeDir, 'projects', '-home-norm-git-myproject');
  const memoryDir = join(projectsDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'notes.md');
  writeFileSync(memoryPath, 'some prose containing real-secret-value inline\n');
  // A nested memory file under a real subdir, exercising the multi-segment
  // relPath resolution (and giving the directory-target guard a real dir).
  const subDir = join(memoryDir, 'sub');
  mkdirSync(subDir, { recursive: true });
  const nestedPath = join(subDir, 'deep.md');
  writeFileSync(nestedPath, 'nested prose containing real-secret-value inline\n');
  const map: PathMap = {
    projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
  };
  return { projectsDir, memoryDir, memoryPath, nestedPath, map };
}

// ---------------------------------------------------------------------------
// memoryFileFromFinding (pure)
// ---------------------------------------------------------------------------

describe('memoryFileFromFinding (pure)', () => {
  it('returns {logical, relPath} for a flat memory path', async () => {
    const { memoryFileFromFinding } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/a.md' });
    expect(memoryFileFromFinding(f)).toEqual({ logical: 'foo', relPath: 'a.md' });
  });

  it('returns null for a non-memory path', async () => {
    const { memoryFileFromFinding } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/abc123.jsonl' });
    expect(memoryFileFromFinding(f)).toBeNull();
  });

  it('captures the multi-segment relPath for a nested memory/sub/a.md path', async () => {
    const { memoryFileFromFinding } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/sub/a.md' });
    expect(memoryFileFromFinding(f)).toEqual({ logical: 'foo', relPath: 'sub/a.md' });
  });

  it('captures a non-.md file under memory/ (any extension)', async () => {
    const { memoryFileFromFinding } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/notes.txt' });
    expect(memoryFileFromFinding(f)).toEqual({ logical: 'foo', relPath: 'notes.txt' });
  });

  it('returns null for a bare memory/ prefix with no trailing file', async () => {
    const { memoryFileFromFinding } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/' });
    expect(memoryFileFromFinding(f)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isMemoryFindingPath (pure)
// ---------------------------------------------------------------------------

describe('isMemoryFindingPath (pure)', () => {
  it('is true for a flat memory/*.md path', async () => {
    const { isMemoryFindingPath } = await import('./memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/a.md' }))).toBe(
      true,
    );
  });

  it('is true for a nested memory/<subdir>/x path (broader than memoryFileFromFinding)', async () => {
    const { isMemoryFindingPath } = await import('./memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/sub/a.md' }))).toBe(
      true,
    );
  });

  it('is true for a non-.md file under memory/', async () => {
    const { isMemoryFindingPath } = await import('./memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/notes.txt' }))).toBe(
      true,
    );
  });

  it('is false for a session .jsonl path outside memory/', async () => {
    const { isMemoryFindingPath } = await import('./memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/abc123.jsonl' }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveMemoryLocalPath
// ---------------------------------------------------------------------------

describe('resolveMemoryLocalPath', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-memory-resolve-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns the encoded local path when the host mapping exists and the file exists', async () => {
    const { memoryPath, map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'notes.md', map)).toBe(memoryPath);
  });

  it('returns the local path for a nested relPath, staying under the memory root', async () => {
    const { memoryDir, nestedPath, map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    const resolved = resolveMemoryLocalPath('myproject', 'sub/deep.md', map);
    expect(resolved).toBe(nestedPath);
    expect((resolved ?? '').startsWith(memoryDir)).toBe(true);
  });

  it('returns the local path for a non-.md memory file that exists', async () => {
    const { memoryDir, map } = makeMemoryFixture(testHome);
    const txtPath = join(memoryDir, 'notes.txt');
    writeFileSync(txtPath, 'some prose\n');
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'notes.txt', map)).toBe(txtPath);
  });

  it('returns null when the project has no entry for the current host', async () => {
    makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    const noHostMap: PathMap = {
      projects: { myproject: { 'other-host': '/home/other/git/myproject' } },
    };
    expect(resolveMemoryLocalPath('myproject', 'notes.md', noHostMap)).toBeNull();
  });

  it('returns null when the encoded local file does not exist on disk', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'missing.md', map)).toBeNull();
  });

  it('returns null when relPath is empty', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', '', map)).toBeNull();
  });

  it('returns null when relPath has a leading /', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', '/notes.md', map)).toBeNull();
  });

  it('returns null when relPath contains a backslash', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'sub\\deep.md', map)).toBeNull();
  });

  it('returns null when relPath has a ".." segment', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', '../escape.md', map)).toBeNull();
  });

  it('returns null when relPath has a "." segment', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', './notes.md', map)).toBeNull();
  });

  it('returns null when relPath has an empty segment (double slash)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'sub//deep.md', map)).toBeNull();
  });

  it('returns null when the target path is a directory, not a regular file', async () => {
    // makeMemoryFixture creates a real `sub/` subdir under memory/.
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'sub', map)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'returns null for a leaf symlink under memory/ that resolves outside the memory root',
    async () => {
      const { memoryDir, map } = makeMemoryFixture(testHome);
      const outsideDir = join(testHome, 'outside');
      mkdirSync(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, 'secret.md');
      writeFileSync(outsideFile, 'outside secret\n');
      symlinkSync(outsideFile, join(memoryDir, 'evil.md'));
      const { resolveMemoryLocalPath } = await import('./memory.ts');
      expect(resolveMemoryLocalPath('myproject', 'evil.md', map)).toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'returns null when an intermediate directory is a symlink escaping the memory root',
    async () => {
      const { memoryDir, map } = makeMemoryFixture(testHome);
      const outsideDir = join(testHome, 'outside');
      mkdirSync(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, 'notes.md');
      writeFileSync(outsideFile, 'outside secret\n');
      // `refs` is a symlinked directory pointing outside the memory root, so a
      // lexically-contained `refs/notes.md` physically resolves outside.
      symlinkSync(outsideDir, join(memoryDir, 'refs'));
      const { resolveMemoryLocalPath } = await import('./memory.ts');
      expect(resolveMemoryLocalPath('myproject', 'refs/notes.md', map)).toBeNull();
    },
  );

  it('throws NomadFatal (via assertSafeLogical) for a poisoned logical name before any join', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./memory.ts');
    const { NomadFatal } = await import('../../../utils.ts');
    expect(() => resolveMemoryLocalPath('../escape', 'notes.md', map)).toThrow(NomadFatal);
  });
});

// ---------------------------------------------------------------------------
// preflightMemoryRedactable
// ---------------------------------------------------------------------------

describe('preflightMemoryRedactable', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-memory-preflight-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('returns null (would proceed) when the memory file resolves cleanly', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { preflightMemoryRedactable } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    expect(preflightMemoryRedactable(f, map)).toBeNull();
  });

  it('returns a refusal reason when the finding is not a memory file', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { preflightMemoryRedactable } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    expect(preflightMemoryRedactable(f, map)).toMatch(/not a project-level memory file/);
  });

  it('returns a refusal reason when the local file cannot be resolved', async () => {
    makeMemoryFixture(testHome);
    const { preflightMemoryRedactable } = await import('./memory.ts');
    const f = makeFinding({ File: 'shared/projects/myproject/memory/missing.md' });
    const emptyMap: PathMap = { projects: {} };
    expect(preflightMemoryRedactable(f, emptyMap)).toMatch(/local file not found or unmapped/);
  });
});

// ---------------------------------------------------------------------------
// applyMemoryRedact
// ---------------------------------------------------------------------------

describe('applyMemoryRedact', () => {
  let testHome: string;
  let originalNomadRepo: string | undefined;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalNomadRepo = process.env.NOMAD_REPO;
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-memory-redact-'));
    process.env.NOMAD_REPO = testHome;
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../../utils.fs.ts');
    vi.doUnmock('../../../utils.ts');
    rmSync(testHome, { recursive: true, force: true });
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
  });

  it('scrubs the local file, backs it up, copies the scrubbed file to the staged memory dir, returns true', async () => {
    const { memoryPath, map } = makeMemoryFixture(testHome);

    const backupSpy = vi.fn();
    vi.doMock('../../../utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });

    const { applyMemoryRedact } = await import('./memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    const fakeScan = (p: string): Finding[] =>
      p === memoryPath
        ? [
            {
              RuleID: 'generic-api-key',
              File: p,
              StartLine: 1,
              StartColumn: 1,
              EndColumn: 10,
              Match: 'real-secret-value',
              Fingerprint: 'fp1',
            },
          ]
        : [];

    const result = applyMemoryRedact(trigger, 'ts-x', map, fakeScan);

    expect(result).toBe(true);
    expect(backupSpy).toHaveBeenCalledOnce();
    // Local file is rewritten in place.
    const localAfter = readFileSync(memoryPath, 'utf8');
    expect(localAfter).toContain('[REDACTED:generic-api-key]');
    expect(localAfter).not.toContain('real-secret-value');
    // Staged copy exists and is also scrubbed.
    const stagedPath = join(testHome, 'shared', 'projects', 'myproject', 'memory', 'notes.md');
    expect(existsSync(stagedPath)).toBe(true);
    const stagedContent = readFileSync(stagedPath, 'utf8');
    expect(stagedContent).toContain('[REDACTED:generic-api-key]');
    expect(stagedContent).not.toContain('real-secret-value');
  });

  it('redacts a nested memory file and preserves the relPath in the staged copy', async () => {
    const { nestedPath, map } = makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/sub/deep.md' });
    const fakeScan = (p: string): Finding[] =>
      p === nestedPath ? [makeFinding({ File: p, Match: 'real-secret-value' })] : [];

    const result = applyMemoryRedact(trigger, 'ts-x', map, fakeScan);

    expect(result).toBe(true);
    // The staged copy is created under the same nested relPath.
    const stagedPath = join(
      testHome,
      'shared',
      'projects',
      'myproject',
      'memory',
      'sub',
      'deep.md',
    );
    expect(existsSync(stagedPath)).toBe(true);
    const stagedContent = readFileSync(stagedPath, 'utf8');
    expect(stagedContent).toContain('[REDACTED:generic-api-key]');
    expect(stagedContent).not.toContain('real-secret-value');
  });

  it('returns false and logs a refusal (no raw secret) when the finding is not a memory file', async () => {
    makeMemoryFixture(testHome);
    const logSpy = vi.fn();
    vi.doMock('../../../utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });
    const { applyMemoryRedact } = await import('./memory.ts');
    const map: PathMap = { projects: {} };
    const trigger = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });

    const result = applyMemoryRedact(trigger, 'ts-x', map);

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const loggedMsg = logSpy.mock.calls[0]?.[0] as string;
    expect(loggedMsg).not.toContain('real-secret-value');
  });

  it('returns false when the local memory file cannot be resolved', async () => {
    makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./memory.ts');
    const emptyMap: PathMap = { projects: {} };
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', emptyMap);

    expect(result).toBe(false);
  });

  it('returns false when the re-scan fails (scan returns null)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', map, () => null);

    expect(result).toBe(false);
  });

  it('returns false when the re-scan finds nothing to redact (empty findings)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', map, () => []);

    expect(result).toBe(false);
  });

  it('warns (no raw secret) via the warning channel when the finding Match is not located in the file', async () => {
    const { memoryPath, map } = makeMemoryFixture(testHome);
    const warnSpy = vi.fn();
    vi.doMock('../../../utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, warn: warnSpy };
    });
    const { applyMemoryRedact } = await import('./memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    // Non-empty scan whose Match value is absent from the file, so applyRedactions
    // returns byte-identical output (after === before).
    const fakeScan = (p: string): Finding[] =>
      p === memoryPath ? [makeFinding({ File: p, Match: 'value-not-present-in-file' })] : [];

    const result = applyMemoryRedact(trigger, 'ts-x', map, fakeScan);

    expect(result).toBe(true);
    const warned = warnSpy.mock.calls.some((c) =>
      String(c[0]).includes('no redaction applied to myproject/memory/notes.md'),
    );
    expect(warned).toBe(true);
    // The warning text never embeds the secret value.
    for (const c of warnSpy.mock.calls)
      expect(String(c[0])).not.toContain('value-not-present-in-file');
    // File is left untouched (the original secret still present, unredacted).
    expect(readFileSync(memoryPath, 'utf8')).toContain('real-secret-value');
  });
});
