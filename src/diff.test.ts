import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as childProcessModule from 'node:child_process';

/**
 * Snapshot helper mirroring preview.test.ts. Captures the `{ relPath:
 * content }` map for every regular file under `root`. Used to assert
 * cmdDiff does not mutate `~/.claude/` or the cache dir.
 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        out[relative(root, abs)] = readFileSync(abs, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

describe('cmdDiff (offline, lockless preview)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let hostsDir: string;
  let lockPath: string;

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
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

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
});
