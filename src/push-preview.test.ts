import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as scanModule from './push-gitleaks.ts';

/**
 * Probe for a usable gitleaks binary once at suite-load time. Real-binary
 * tests (planted-leak FATAL, clean-scan line) require gitleaks; mocked tests
 * (staged-zero, scan-crash, REPO_HOME non-mutation, temp-cleanup) run without
 * it. Gate the real-binary suite via `describe.skipIf(!hasGitleaks)`.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Shared sandbox state used by every describe block. */
type PreviewEnv = {
  originalHome: string | undefined;
  originalNomadHost: string | undefined;
  originalNomadRepo: string | undefined;
  originalExitCode: typeof process.exitCode;
  testHome: string;
  repoUnderHome: string;
  claudeHome: string;
};

/**
 * Create a minimal sandbox: a temp HOME with a `claude-nomad/` repo dir, a
 * `~/.claude/projects/` tree, and a `path-map.json` pointing at an empty
 * projects map. Sets `NOMAD_REPO` so `REPO_HOME` resolves to the temp dir.
 * Resets the module cache so each test loads a fresh `previewPushLeaks`.
 *
 * @returns The sandbox state for teardown.
 */
function makePreviEnv(): PreviewEnv {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const originalNomadRepo = process.env.NOMAD_REPO;
  const originalExitCode = process.exitCode;

  const testHome = mkdtempSync(join(tmpdir(), 'nomad-push-preview-test-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';

  const repoUnderHome = join(testHome, 'claude-nomad');
  const claudeHome = join(testHome, '.claude');

  mkdirSync(repoUnderHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });

  // Point NOMAD_REPO at the temp repo so REPO_HOME resolves to it.
  process.env.NOMAD_REPO = repoUnderHome;

  writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

  vi.resetModules();
  return {
    originalHome,
    originalNomadHost,
    originalNomadRepo,
    originalExitCode,
    testHome,
    repoUnderHome,
    claudeHome,
  };
}

/**
 * Tear down the sandbox: restore all mocks, module mocks, env vars,
 * `process.exitCode`, and remove the temp HOME tree.
 *
 * @param env - The sandbox returned by `makePreviEnv`.
 */
function teardownPreviewEnv(env: PreviewEnv): void {
  vi.restoreAllMocks();
  vi.doUnmock('./push-gitleaks.ts');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  process.exitCode = env.originalExitCode;
  if (env.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.originalHome;
  if (env.originalNomadHost === undefined) delete process.env.NOMAD_HOST;
  else process.env.NOMAD_HOST = env.originalNomadHost;
  if (env.originalNomadRepo === undefined) delete process.env.NOMAD_REPO;
  else process.env.NOMAD_REPO = env.originalNomadRepo;
  rmSync(env.testHome, { recursive: true, force: true });
}

/**
 * Write a `path-map.json` mapping the encoded dir of `localPath` on
 * `'test-host'` to `logical`, and create a matching session JSONL under
 * `~/.claude/projects/<encoded>/`. Returns the encoded dir name and the session
 * id used.
 */
function plantSession(
  env: PreviewEnv,
  logical: string,
  localPath: string,
  content: string,
): { encodedDir: string; sid: string } {
  const encoded = localPath.replace(/\//g, '-');
  const projectsDir = join(env.claudeHome, 'projects', encoded);
  mkdirSync(projectsDir, { recursive: true });
  const sid = 'test-session-01';
  writeFileSync(join(projectsDir, `${sid}.jsonl`), content);
  // Update the path-map.json to include this mapping.
  const mapContent = { projects: { [logical]: { 'test-host': localPath } } };
  writeFileSync(join(env.repoUnderHome, 'path-map.json'), JSON.stringify(mapContent) + '\n');
  return { encodedDir: encoded, sid };
}

// ---------------------------------------------------------------------------
// Mocked suites: run without the real gitleaks binary.
// ---------------------------------------------------------------------------

describe('previewPushLeaks: nothing staged (no mapped sessions, no extras)', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured: previewPushLeaks no longer logs, but suppress any incidental */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('returns a neutral nothing-to-scan verdict and does not set exitCode 1 when nothing is mapped', async () => {
    // No sessions in path-map (projects: {}), no extras. scanStagedTree must
    // NOT be invoked.
    const scanMock = vi.fn(() => [] as scanModule.Finding[]);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: {} };
    const verdict = previewPushLeaks(map);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/nothing to scan, no leaks/i);
    // gitleaks must not have been invoked.
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('returns a nothing-to-scan verdict (no scan) when map.projects is not an object', async () => {
    // Covers the `typeof map.projects !== 'object'` guard in stageSessions.
    const scanMock = vi.fn(() => [] as scanModule.Finding[]);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    // Pass a map whose projects field is a string (not an object).
    const map = { projects: 'bad' as unknown as Record<string, Record<string, string>> };
    const verdict = previewPushLeaks(map);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(verdict.leak).toBe(false);
    expect(verdict.verdictRow).toMatch(/nothing to scan, no leaks/i);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('returns a nothing-to-scan verdict (no scan, no throw) when map.projects is a non-object but extras is present', async () => {
    // Covers the WR-01 guard in stageExtras: a malformed map with an `extras`
    // block but a non-object `projects` must NOT throw on the
    // `map.projects[logical]` read; it stages nothing and returns clean.
    const scanMock = vi.fn(() => [] as scanModule.Finding[]);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = {
      projects: 'bad' as unknown as Record<string, Record<string, string>>,
      extras: { 'my-project': ['.planning'] },
    };
    expect(() => previewPushLeaks(map)).not.toThrow();
    const verdict = previewPushLeaks(map);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(verdict.leak).toBe(false);
    expect(verdict.verdictRow).toMatch(/nothing to scan, no leaks/i);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('skips an unmapped local project dir and still returns a nothing-to-scan verdict', async () => {
    // Covers the `!logical` continue in stageSessions: a dir in ~/.claude/projects/
    // that has no reverse-map entry is silently skipped.
    const scanMock = vi.fn((): scanModule.Finding[] | null => []);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    // Create an unmapped dir under ~/.claude/projects/.
    const unmappedDir = join(env.claudeHome, 'projects', '-unmapped-project-');
    mkdirSync(unmappedDir, { recursive: true });
    writeFileSync(join(unmappedDir, 'session.jsonl'), '{"role":"user"}\n');
    // path-map has no entry for this encoded dir.
    const map = { projects: {} };
    const verdict = previewPushLeaks(map);
    // Nothing staged (dir is not in the reverse map), so no scan.
    expect(scanMock).not.toHaveBeenCalled();
    expect(verdict.leak).toBe(false);
    expect(verdict.verdictRow).toMatch(/nothing to scan, no leaks/i);
  });

  it('returns a clean no-leaks verdict (not a nothing-to-scan row) when a session scans clean', async () => {
    // Covers the empty-findings branch of verdictFromFindings: a mapped session
    // is staged + scanned, scan returns [], so verdictRow is the clean row.
    const scanMock = vi.fn((): scanModule.Finding[] | null => []);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);
    expect(scanMock).toHaveBeenCalledOnce();
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/no leaks/);
    expect(verdict.verdictRow).not.toMatch(/nothing to scan/);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });
});

describe('previewPushLeaks: scan crash (null findings)', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('returns a scan-failed verdict (not a leak) and sets exitCode 1 when scanStagedTree returns null', async () => {
    // Plant a session so staged > 0 (otherwise we never reach scanStagedTree).
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');

    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => null),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);
    expect(process.exitCode).toBe(1);
    // A scan crash is surfaced as a ✗ row but is NOT a leak (no throw, no
    // phantom drop-session recovery).
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/scan failed/i);
    expect(verdict.verdictRow).not.toContain('nomad drop-session');
  });

  it('returns a scan-error verdict (not a leak) and sets exitCode 1 when scanStagedTree throws', async () => {
    // Covers the catch branch in previewPushLeaks (gitleaks/git not on PATH).
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');

    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);
    expect(process.exitCode).toBe(1);
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/scan error/i);
    // ENOENT keeps the "not on PATH" wording (binary genuinely missing).
    expect(verdict.verdictRow).toMatch(/not on PATH/i);
  });

  it('surfaces the real error message (not the PATH hint) on a non-ENOENT scan throw', async () => {
    // A non-ENOENT throw (e.g. EACCES) must not be mislabeled as a missing
    // binary; the verdict row carries the underlying error message instead.
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');

    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);
    expect(process.exitCode).toBe(1);
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/permission denied/);
    expect(verdict.verdictRow).not.toMatch(/not on PATH/i);
  });
});

describe('previewPushLeaks: REPO_HOME/shared non-mutation', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('does not create or mutate REPO_HOME/shared after a preview', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => []),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    // Plant a session so the staging path runs, even though the scan is mocked clean.
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    previewPushLeaks(map);
    // REPO_HOME/shared must be absent (never created by the preview).
    expect(existsSync(join(env.repoUnderHome, 'shared'))).toBe(false);
  });
});

describe('previewPushLeaks: temp-tree cleanup', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('removes the temp staging tree after a clean-scan preview', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => []),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    previewPushLeaks(map);
    // The cacheDir itself may exist (created by mkdirSync) but there must be
    // no push-preview-tree-* subdirectory left.
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('removes the temp staging tree after a scan-failure (null) preview', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => null),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    previewPushLeaks(map);
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('removes the temp staging tree after a scan ENOENT throw', async () => {
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          const err = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
          throw err;
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    previewPushLeaks(map);
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });
});

describe('previewPushLeaks: extras staging', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('stages whitelisted extras into the temp tree (not REPO_HOME/shared)', async () => {
    // Plant a session + a .planning extras dir for the logical project.
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const planningDir = join(localPath, '.planning');
    mkdirSync(planningDir, { recursive: true });
    writeFileSync(join(planningDir, 'STATE.md'), '# state\n');

    const mapContent = {
      projects: { [logical]: { 'test-host': localPath } },
      extras: { [logical]: ['.planning'] },
    };
    writeFileSync(join(env.repoUnderHome, 'path-map.json'), JSON.stringify(mapContent) + '\n');

    // Track the temp root the scan was called with.
    let scannedRoot = '';
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((dir: string): scanModule.Finding[] | null => {
          scannedRoot = dir;
          return [];
        }),
      };
    });

    const { previewPushLeaks } = await import('./push-preview.ts');
    previewPushLeaks(mapContent);
    // The scanned root must not be under REPO_HOME/shared.
    expect(scannedRoot).not.toBe('');
    expect(scannedRoot).not.toContain(env.repoUnderHome);
    // REPO_HOME/shared must remain absent.
    expect(existsSync(join(env.repoUnderHome, 'shared'))).toBe(false);
  });

  it('skips extras for logicals with no host path (nothing staged, no scan invoked)', async () => {
    const mapContent = {
      projects: { 'other-project': { 'other-host': '/remote/path' } },
      extras: { 'other-project': ['.planning'] },
    };
    let scanCalled = false;
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          scanCalled = true;
          return [];
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    previewPushLeaks(mapContent);
    // Nothing was staged (no host path for 'test-host'), so scanStagedTree must not be called.
    expect(scanCalled).toBe(false);
  });

  it('skips a non-whitelisted extras dirname and still scans the session', async () => {
    // Covers the `!whitelist.includes(dirname)` continue in stageExtras (line 86).
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const notWhitelisted = 'some-random-dir';
    mkdirSync(join(localPath, notWhitelisted), { recursive: true });

    const mapContent = {
      projects: { [logical]: { 'test-host': localPath } },
      extras: { [logical]: [notWhitelisted] },
    };
    writeFileSync(join(env.repoUnderHome, 'path-map.json'), JSON.stringify(mapContent) + '\n');

    let scanCalled = false;
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          scanCalled = true;
          return [];
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    previewPushLeaks(mapContent);
    // Session was staged (1 session dir), so scan must have been called.
    expect(scanCalled).toBe(true);
    // REPO_HOME/shared still absent (only sessions staged into tmp, no extras).
    expect(existsSync(join(env.repoUnderHome, 'shared'))).toBe(false);
  });

  it('skips extras whose source path does not exist locally', async () => {
    // Covers the `!existsSync(src)` continue in stageExtras (line 88).
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    // Do NOT create .planning under localPath; source is absent.

    const mapContent = {
      projects: { [logical]: { 'test-host': localPath } },
      extras: { [logical]: ['.planning'] },
    };
    writeFileSync(join(env.repoUnderHome, 'path-map.json'), JSON.stringify(mapContent) + '\n');

    let scanCalled = false;
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return {
        ...actual,
        scanStagedTree: vi.fn((): scanModule.Finding[] | null => {
          scanCalled = true;
          return [];
        }),
      };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    previewPushLeaks(mapContent);
    // Session was staged, so scan runs. Extras were skipped (src missing).
    expect(scanCalled).toBe(true);
    expect(existsSync(join(env.repoUnderHome, 'shared'))).toBe(false);
  });
});

describe('previewPushLeaks: path-traversal guard (fail-closed before copy)', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('throws on an unsafe session logical (path separator) before scanning', async () => {
    // An unsafe logical key in map.projects must fail closed via
    // assertSafeLogical in stageSessions, before any copy or scan.
    const scanMock = vi.fn((): scanModule.Finding[] | null => []);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const localPath = join(env.testHome, 'my-project');
    const map = { projects: { 'foo/bar': { 'test-host': localPath } } };
    expect(() => previewPushLeaks(map)).toThrow(/invalid logical name/i);
    // Fail-closed: the scan must never run.
    expect(scanMock).not.toHaveBeenCalled();
    // No staging tree content escaped (temp tree cleaned by finally).
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('throws on an unsafe extras logical (..) before scanning', async () => {
    // An unsafe logical in the extras block must fail closed via
    // assertSafeLogical in stageExtras, before any copy or scan.
    const scanMock = vi.fn((): scanModule.Finding[] | null => []);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = {
      // Keep projects safe so the throw originates in stageExtras, not stageSessions.
      projects: {},
      extras: { '../escape': ['.planning'] },
    };
    expect(() => previewPushLeaks(map)).toThrow(/invalid logical name/i);
    expect(scanMock).not.toHaveBeenCalled();
    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('stages and scans normally for a safe logical (guard does not over-reject)', async () => {
    // The guard must not reject a normal [A-Za-z0-9._-]+ logical.
    const scanMock = vi.fn((): scanModule.Finding[] | null => []);
    vi.doMock('./push-gitleaks.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof scanModule>();
      return { ...actual, scanStagedTree: scanMock };
    });
    const { previewPushLeaks } = await import('./push-preview.ts');
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    plantSession(env, logical, localPath, '{"role":"user","text":"hello"}\n');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    expect(() => previewPushLeaks(map)).not.toThrow();
    expect(scanMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Real-gitleaks integration tests (skipped when gitleaks is not on PATH).
// ---------------------------------------------------------------------------

describe.skipIf(!hasGitleaks)('previewPushLeaks: real gitleaks integration', () => {
  let env: PreviewEnv;

  beforeEach(() => {
    env = makePreviEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    teardownPreviewEnv(env);
  });

  it('planted leak produces buildSessionAwareFatal body and sets exitCode 1', async () => {
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    // Assemble a real-looking PAT from split fragments so no contiguous
    // PAT-shaped token sits in source-controlled bytes.
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    const { sid } = plantSession(
      env,
      logical,
      localPath,
      `{"role":"user","text":"token=${fakePat}"}\n`,
    );

    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);

    expect(process.exitCode).toBe(1);
    expect(verdict.leak).toBe(true);
    // The one-line verdict row names the affected session count.
    expect(verdict.verdictRow).toMatch(/gitleaks detected secrets in \d+ session transcript/);
    // The recovery body carries the session-aware drop-session hint.
    expect(verdict.recovery).not.toBeNull();
    expect(verdict.recovery ?? '').toContain(`nomad drop-session ${sid}`);
    // The verdict row itself is a clean one-liner, not the no-leaks row.
    expect(verdict.verdictRow).not.toMatch(/no leaks/i);
  });

  it('removes the temp staging tree after a planted-leak preview', async () => {
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    plantSession(env, logical, localPath, `{"role":"user","text":"token=${fakePat}"}\n`);

    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    previewPushLeaks(map);

    const cacheDir = join(env.testHome, '.cache', 'claude-nomad');
    const remaining = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((n) => n.startsWith('push-preview-tree-'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('clean staged tree returns a no-leaks verdict and does not set exitCode 1', async () => {
    const logical = 'my-project';
    const localPath = join(env.testHome, 'my-project');
    // Content with no secrets.
    plantSession(env, logical, localPath, '{"role":"user","text":"hello world"}\n');

    const { previewPushLeaks } = await import('./push-preview.ts');
    const map = { projects: { [logical]: { 'test-host': localPath } } };
    const verdict = previewPushLeaks(map);

    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(verdict.leak).toBe(false);
    expect(verdict.recovery).toBeNull();
    expect(verdict.verdictRow).toMatch(/no leaks/);
  });
});
