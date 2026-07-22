import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as utilsFsModule from './utils.fs.ts';
import type * as utilsModule from './utils.ts';
import type { PathMap } from './config.ts';
import type { Finding } from './push-gitleaks.scan.ts';

/**
 * Unit tests for `src/commands.push.recovery.memory.ts`: the project-level
 * memory-file resolution and redaction seam. Fixtures deliberately mirror the
 * REAL, empirically-observed layout (`memory/` as a flat, project-level
 * sibling of every `<sid>/` subtree, NOT nested inside one), distinguishing
 * this suite from the session-subtree fixtures in
 * `commands.push.recovery.redact.test.ts`.
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
  map: PathMap;
} {
  const claudeHomeDir = join(testHome, '.claude');
  const projectsDir = join(claudeHomeDir, 'projects', '-home-norm-git-myproject');
  const memoryDir = join(projectsDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'notes.md');
  writeFileSync(memoryPath, 'some prose containing real-secret-value inline\n');
  const map: PathMap = {
    projects: { myproject: { 'test-host': '/home/norm/git/myproject' } },
  };
  return { projectsDir, memoryDir, memoryPath, map };
}

// ---------------------------------------------------------------------------
// memoryFileFromFinding (pure)
// ---------------------------------------------------------------------------

describe('memoryFileFromFinding (pure)', () => {
  it('returns {logical, filename} for a flat memory path', async () => {
    const { memoryFileFromFinding } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/a.md' });
    expect(memoryFileFromFinding(f)).toEqual({ logical: 'foo', filename: 'a.md' });
  });

  it('returns null for a non-memory path', async () => {
    const { memoryFileFromFinding } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/abc123.jsonl' });
    expect(memoryFileFromFinding(f)).toBeNull();
  });

  it('returns null for a nested memory/sub/a.md path', async () => {
    const { memoryFileFromFinding } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/sub/a.md' });
    expect(memoryFileFromFinding(f)).toBeNull();
  });

  it('returns null for a non-.md file under memory/', async () => {
    const { memoryFileFromFinding } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/foo/memory/notes.txt' });
    expect(memoryFileFromFinding(f)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isMemoryFindingPath (pure)
// ---------------------------------------------------------------------------

describe('isMemoryFindingPath (pure)', () => {
  it('is true for a flat memory/*.md path', async () => {
    const { isMemoryFindingPath } = await import('./commands.push.recovery.memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/a.md' }))).toBe(
      true,
    );
  });

  it('is true for a nested memory/<subdir>/x path (broader than memoryFileFromFinding)', async () => {
    const { isMemoryFindingPath } = await import('./commands.push.recovery.memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/sub/a.md' }))).toBe(
      true,
    );
  });

  it('is true for a non-.md file under memory/', async () => {
    const { isMemoryFindingPath } = await import('./commands.push.recovery.memory.ts');
    expect(isMemoryFindingPath(makeFinding({ File: 'shared/projects/foo/memory/notes.txt' }))).toBe(
      true,
    );
  });

  it('is false for a session .jsonl path outside memory/', async () => {
    const { isMemoryFindingPath } = await import('./commands.push.recovery.memory.ts');
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
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'notes.md', map)).toBe(memoryPath);
  });

  it('returns null when the project has no entry for the current host', async () => {
    makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    const noHostMap: PathMap = {
      projects: { myproject: { 'other-host': '/home/other/git/myproject' } },
    };
    expect(resolveMemoryLocalPath('myproject', 'notes.md', noHostMap)).toBeNull();
  });

  it('returns null when the encoded local file does not exist on disk', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'missing.md', map)).toBeNull();
  });

  it('returns null when the filename fails the SAFE_MEMORY_FILENAME shape (contains a separator)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    expect(resolveMemoryLocalPath('myproject', 'a/b.md', map)).toBeNull();
  });

  it('returns null when the filename contains ".." even though it matches the .md shape', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    // "..md" has no separator and ends in ".md", so it passes SAFE_MEMORY_FILENAME;
    // the explicit .includes('..') guard must still reject it.
    expect(resolveMemoryLocalPath('myproject', '..md', map)).toBeNull();
  });

  it('throws NomadFatal (via assertSafeLogical) for a poisoned logical name before any join', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { resolveMemoryLocalPath } = await import('./commands.push.recovery.memory.ts');
    const { NomadFatal } = await import('./utils.ts');
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
    const { preflightMemoryRedactable } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    expect(preflightMemoryRedactable(f, map)).toBeNull();
  });

  it('returns a refusal reason when the finding is not a memory file', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { preflightMemoryRedactable } = await import('./commands.push.recovery.memory.ts');
    const f = makeFinding({ File: 'shared/projects/myproject/sid123.jsonl' });
    expect(preflightMemoryRedactable(f, map)).toMatch(/not a project-level memory file/);
  });

  it('returns a refusal reason when the local file cannot be resolved', async () => {
    makeMemoryFixture(testHome);
    const { preflightMemoryRedactable } = await import('./commands.push.recovery.memory.ts');
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
    vi.doUnmock('./utils.fs.ts');
    vi.doUnmock('./utils.ts');
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
    vi.doMock('./utils.fs.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsFsModule>();
      return { ...actual, backupBeforeWrite: backupSpy };
    });

    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
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

  it('returns false and logs a refusal (no raw secret) when the finding is not a memory file', async () => {
    makeMemoryFixture(testHome);
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });
    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
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
    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
    const emptyMap: PathMap = { projects: {} };
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', emptyMap);

    expect(result).toBe(false);
  });

  it('returns false when the re-scan fails (scan returns null)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', map, () => null);

    expect(result).toBe(false);
  });

  it('returns false when the re-scan finds nothing to redact (empty findings)', async () => {
    const { map } = makeMemoryFixture(testHome);
    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });

    const result = applyMemoryRedact(trigger, 'ts-x', map, () => []);

    expect(result).toBe(false);
  });

  it('logs a no-op warning (no raw secret) when the finding Match is not located in the file', async () => {
    const { memoryPath, map } = makeMemoryFixture(testHome);
    const logSpy = vi.fn();
    vi.doMock('./utils.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof utilsModule>();
      return { ...actual, log: logSpy };
    });
    const { applyMemoryRedact } = await import('./commands.push.recovery.memory.ts');
    const trigger = makeFinding({ File: 'shared/projects/myproject/memory/notes.md' });
    // Non-empty scan whose Match value is absent from the file, so applyRedactions
    // returns byte-identical output (after === before).
    const fakeScan = (p: string): Finding[] =>
      p === memoryPath ? [makeFinding({ File: p, Match: 'value-not-present-in-file' })] : [];

    const result = applyMemoryRedact(trigger, 'ts-x', map, fakeScan);

    expect(result).toBe(true);
    const warned = logSpy.mock.calls.some((c) =>
      String(c[0]).includes('no redaction applied to myproject/memory/notes.md'),
    );
    expect(warned).toBe(true);
    // The warning text never embeds the secret value.
    for (const c of logSpy.mock.calls)
      expect(String(c[0])).not.toContain('value-not-present-in-file');
    // File is left untouched (the original secret still present, unredacted).
    expect(readFileSync(memoryPath, 'utf8')).toContain('real-secret-value');
  });
});
