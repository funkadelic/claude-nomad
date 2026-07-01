import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as childProcessModule from 'node:child_process';

/**
 * Snapshot helper mirroring preview.test.ts. Captures the `{ relPath:
 * content }` map for every regular file under `root`. Used to assert
 * cmdDiff does not mutate `~/.claude/` or the cache dir. Reads directly
 * via readFileSync and recurses on EISDIR instead of stat-then-read so
 * the helper has no check-then-use pattern between sibling fs calls.
 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      try {
        out[relative(root, abs)] = readFileSync(abs, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EISDIR') walk(abs);
        else throw err;
      }
    }
  };
  walk(root);
  return out;
}

describe('cmdDiff (offline, lockless preview)', () => {
  type LogSpy = MockInstance<(...args: unknown[]) => void>;
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let hostsDir: string;
  let lockPath: string;
  let logSpy: LogSpy;
  let errSpy: LogSpy;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    process.env.NO_COLOR = '1';
    testHome = mkdtempSync(join(tmpdir(), 'nomad-diff-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    hostsDir = join(repoUnderHome, 'hosts');
    claudeDir = join(testHome, '.claude');
    lockPath = join(testHome, '.cache', 'claude-nomad', 'nomad.lock');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(hostsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  /**
   * Stitch every recorded `console.log` call into a single newline-joined
   * string so assertions can match on substrings or the position of a
   * particular line within the run's full output.
   */
  function logOutput(): string {
    return logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  /** Sibling of `logOutput` for `console.error` (warn/fail glyph output). */
  function errOutput(): string {
    return errSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    delete process.env.NO_COLOR;
    process.exitCode = 0;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does NOT invoke git pull and does NOT acquire the lockfile', async () => {
    // Sandbox: a minimally-scaffolded repo so computePreview has something to
    // do. settings.base.json exists, no host file, an empty path-map.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const execSpy = vi.fn(() => Buffer.from(''));
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return { ...actual, execFileSync: execSpy };
    });

    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();

    // No git invocation at all.
    expect(execSpy).not.toHaveBeenCalled();
    // No lockfile creation.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not mutate any file under ~/.claude/ or ~/.cache/claude-nomad/', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet' }, null, 2) + '\n',
    );
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const beforeClaude = snapshotTree(claudeDir);
    const cacheRoot = join(testHome, '.cache', 'claude-nomad');
    const beforeCache = snapshotTree(cacheRoot);

    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();

    expect(snapshotTree(claudeDir)).toEqual(beforeClaude);
    expect(snapshotTree(cacheRoot)).toEqual(beforeCache);
  });

  it('dies cleanly when REPO_HOME does not exist', async () => {
    rmSync(repoUnderHome, { recursive: true, force: true });
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    expect(process.exitCode).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('tolerates a partially-scaffolded repo (no settings.base.json) without throwing', async () => {
    // No settings.base.json. cmdDiff is the offline-safe surface; computePreview
    // emits the locked skip phrasing and continues to the projects section.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    expect(() => cmdDiff()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('tolerates a missing path-map.json (falls back to an empty project map)', async () => {
    // No path-map.json written: cmdDiff must use the `{ projects: {} }` fallback
    // rather than throwing, so a partially-scaffolded repo still previews.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    expect(() => cmdDiff()).not.toThrow();
    expect(existsSync(join(repoUnderHome, 'path-map.json'))).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rethrows non-NomadFatal errors raised by computePreview unchanged', async () => {
    // Sandbox is otherwise normal; computePreview is mocked to throw a plain
    // Error so the cmdDiff catch hits its else branch (the NomadFatal arm is
    // already covered by the REPO_HOME-missing test). The caught Error must
    // propagate as-is rather than be converted into a NomadFatal.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const sentinel = new Error('synthetic computePreview failure');
    vi.doMock('./preview.ts', () => ({
      computePreview: vi.fn(() => {
        throw sentinel;
      }),
    }));
    const { cmdDiff } = await import('./diff.ts');
    const { NomadFatal } = await import('./utils.ts');
    let thrown: unknown;
    try {
      cmdDiff();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(sentinel);
    expect(thrown).not.toBeInstanceOf(NomadFatal);
    // The catch arm should not have set the FATAL exitCode for non-NomadFatal.
    expect(process.exitCode).not.toBe(1);
    vi.doUnmock('./preview.ts');
  });

  it('emits the unmapped-on-diff summary line when path-map has unmapped entries', async () => {
    // Two path-map entries that have no host mapping for `test-host`.
    // remapPull's dry-run branch (driven by computePreview) increments
    // `unmapped` for each, so the Summary tree row reports `2 unmapped on diff`.
    // The row renders via summaryRow -> renderTree -> console.log (logOutput).
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedDir, 'projects', 'logical-a'), { recursive: true });
    mkdirSync(join(sharedDir, 'projects', 'logical-b'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          'logical-a': { 'test-host': 'TBD' },
          'logical-b': { 'other-host': '/other/path' },
        },
      }) + '\n',
    );
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    expect(logOutput()).toContain('2 unmapped on diff (run nomad doctor to list)');
    // Summary goes through renderTree (stdout / logOutput), not emitSummary (stderr).
    expect(errOutput()).not.toContain('summary:');
  });

  it('emits the clean summary line on a fully-mapped repo', async () => {
    // Empty path-map -> remapPull's loop never increments unmapped.
    // Clean summary renders via summaryRow inside renderTree (console.log).
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    expect(logOutput()).toContain('clean');
    // No duplicate in stderr.
    expect(errOutput()).not.toContain('summary:');
  });

  it('Summary row appears exactly ONCE in the output (no double-print)', async () => {
    // computePreview renders Summary via renderTree; removing the old
    // emitSummary call ensures the row is printed exactly once.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    // The plain Summary row no longer carries a 'summary:' prefix; on the
    // empty-path-map clean fixture the row is exactly 'clean', so match on that.
    const summaryLines = logOutput()
      .split('\n')
      .filter((l) => l.includes('clean'));
    expect(summaryLines).toHaveLength(1);
  });

  it('emits the summary line as the LAST non-blank log line of cmdDiff', async () => {
    // The tree summary item is the terminator; the diff verb has no
    // `dry-run complete` log line after it.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    const lines = logOutput()
      .split('\n')
      .filter((s) => s.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('clean');
  });

  it('surfaces the retained local-only count as a non-clean Summary (parity with pull --dry-run)', async () => {
    // Mapped project foo -> projectRoot with an unpushed local-only session leaf
    // under the host encoded dir. cmdDiff routes through the same computePreview
    // as pull --dry-run, so the honest local-only count must appear here too.
    const projectRoot = join(testHome, 'fake-project');
    const encodedLocal = join(claudeDir, 'projects', projectRoot.replace(/\//g, '-'));
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedDir, 'projects', 'foo'), { recursive: true });
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'local-only.jsonl'), '{"local":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': projectRoot } } }) + '\n',
    );

    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();

    expect(logOutput()).toContain('1 local-only present, not in repo (push to reconcile)');
    expect(logOutput()).toContain('1 local-only present');
    expect(
      logOutput()
        .split('\n')
        .filter((l) => l.includes('clean')),
    ).toHaveLength(0);
  });

  it('fires the Gap B divergence WARN like pull --dry-run and stays offline/lockless', async () => {
    // Diverged repo-tracked .planning file plus an unpushed local-only session,
    // exactly the 2026-06-30 signal-failure class. cmdDiff must surface BOTH the
    // keep-local divergence WARN (matching pull --dry-run, which fires
    // divergenceCheckExtras) and the local-only count, while creating no backup
    // dir and never invoking git pull.
    const projectRoot = join(testHome, 'fake-project');
    const encodedLocal = join(claudeDir, 'projects', projectRoot.replace(/\//g, '-'));
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    // Session side: repo-tracked foo/ plus a local-only leaf.
    mkdirSync(join(sharedDir, 'projects', 'foo'), { recursive: true });
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'local-only.jsonl'), '{"local":1}\n');
    // Extras side: a diverged .planning/STATE.md (local content != repo content).
    mkdirSync(join(projectRoot, '.planning'), { recursive: true });
    writeFileSync(join(projectRoot, '.planning', 'STATE.md'), 'local state\n');
    mkdirSync(join(sharedDir, 'extras', 'foo', '.planning'), { recursive: true });
    writeFileSync(join(sharedDir, 'extras', 'foo', '.planning', 'STATE.md'), 'repo state\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    // Spy execFileSync but call through to real git so divergence detection
    // works; this lets us assert git pull is never invoked.
    const execCalls: unknown[][] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFileSync: (...args: unknown[]) => {
          execCalls.push(args);
          return (actual.execFileSync as (...a: unknown[]) => Buffer)(...args);
        },
      };
    });

    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();

    // Gap B divergence WARN (keep-local / push-to-reconcile phrasing).
    const stderr = errOutput();
    expect(stderr).toContain('keep your local copy (push to reconcile');
    expect(stderr).not.toContain('overwrite');
    // Local-only count also surfaces (session parity).
    expect(logOutput()).toContain('1 local-only present, not in repo (push to reconcile)');
    // Offline/lockless: no lockfile, no backup dir, no git pull.
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'backup'))).toBe(false);
    const ranGitPull = execCalls.some(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('pull'),
    );
    expect(ranGitPull).toBe(false);
    vi.doUnmock('node:child_process');
  });

  it('no ℹ︎ glyph appears in cmdDiff tree sections when repo is fully scaffolded', async () => {
    // A fully-scaffolded sandbox: settings.base.json, shared/projects/ dir,
    // and path-map.json so remapPull enters the project loop rather than the
    // early-return log path. The tree sections (Symlinks, Sessions, Summary,
    // settings.json) must contain no ℹ︎ glyph.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedDir, 'projects'), { recursive: true });
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    const { cmdDiff } = await import('./diff.ts');
    cmdDiff();
    expect(logOutput()).not.toContain('ℹ');
    expect(errOutput()).not.toContain('ℹ');
  });
});
