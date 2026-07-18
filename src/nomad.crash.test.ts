import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { EXIT } from './exit-codes.ts';
import { buildPushRepo } from './test-support/git.ts';
import { runNomad, type Host } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. The NomadFatal
 * exemption fixture below needs real git plumbing (a `.git/rebase-merge`
 * marker directory) inside a real repo, so gate that case to skip cleanly on
 * a host without git rather than failing with an unhelpful spawn error.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Build a minimal `Host`-shaped env for `runNomad`, mirroring the fixture in
 * `src/nomad.exit-codes.test.ts`. `NOMAD_TEST_FORCE_CRASH` /
 * `NOMAD_TEST_FORCE_ASYNC_CRASH` are merged in per-call by the caller.
 *
 * @param home - Scratch HOME directory for the subprocess.
 * @param repo - Repository clone path to use as `NOMAD_REPO`.
 * @param extraEnv - Extra env vars merged on top of the base env.
 * @returns A `Host`-shaped object ready for `runNomad`.
 */
function makeMinimalHost(home: string, repo: string, extraEnv: NodeJS.ProcessEnv = {}): Host {
  mkdirSync(home, { recursive: true });
  return {
    home,
    claudeHome: join(home, '.claude'),
    repo,
    hostname: 'crash-host',
    env: {
      ...process.env,
      HOME: home,
      NOMAD_REPO: repo,
      NOMAD_HOST: 'crash-host',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...extraEnv,
    },
  };
}

/**
 * List the crash report files under `<home>/.cache/claude-nomad/crash/`.
 * Returns `[]` when the directory does not exist (never thrown crash case).
 *
 * @param home - Scratch HOME directory the subprocess ran with.
 * @returns File names directly under the crash directory.
 */
function listCrashDir(home: string): string[] {
  const dir = join(home, '.cache', 'claude-nomad', 'crash');
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('nomad crash handler (subprocess, real dev entry)', () => {
  it('a forced synchronous crash writes a redacted crash file and exits GENERIC_FAILURE', () => {
    const home = mkdtempSync(join(tmpdir(), 'nomad-crash-sync-'));
    const host = makeMinimalHost(home, join(home, 'unused-repo'), {
      NOMAD_TEST_FORCE_CRASH: '1',
    });
    try {
      const result = runNomad(host, ['--version']);
      expect(result.status).toBe(EXIT.GENERIC_FAILURE);
      expect(result.stderr).toContain('This looks like a bug');
      expect(result.stdout).toContain(pkg.bugs.url);

      const files = listCrashDir(home);
      expect(files).toHaveLength(1);
      const contents = readFileSync(
        join(home, '.cache', 'claude-nomad', 'crash', files[0]),
        'utf8',
      );
      expect(contents).toContain('Error');
      expect(contents).toContain('forced test crash');
      // Structural scrub: the raw scratch HOME path must never appear.
      expect(contents).not.toContain(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a forced async (unhandledRejection) crash writes a crash file and exits GENERIC_FAILURE', () => {
    const home = mkdtempSync(join(tmpdir(), 'nomad-crash-async-'));
    const host = makeMinimalHost(home, join(home, 'unused-repo'), {
      NOMAD_TEST_FORCE_ASYNC_CRASH: '1',
    });
    try {
      const result = runNomad(host, ['--version']);
      expect(result.status).toBe(EXIT.GENERIC_FAILURE);
      expect(result.stderr).toContain('This looks like a bug');
      expect(result.stdout).toContain(pkg.bugs.url);

      const files = listCrashDir(home);
      expect(files).toHaveLength(1);
      const contents = readFileSync(
        join(home, '.cache', 'claude-nomad', 'crash', files[0]),
        'utf8',
      );
      expect(contents).toContain('Error');
      expect(contents).toContain('forced test async crash');
      expect(contents).not.toContain(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe.skipIf(!hasGit)('NomadFatal exemption (real git fixture)', () => {
    it('a real NomadFatal keeps its own exit code, prints no crash banner, and writes no crash file', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'nomad-crash-fatal-'));
      const home = mkdtempSync(join(tmpdir(), 'nomad-crash-fatal-home-'));
      try {
        const { local } = buildPushRepo(tmp);
        // Plant a mid-rebase marker directly, same fixture shape as the
        // CONFLICT case in nomad.exit-codes.test.ts: classifyWedge is a pure
        // marker-file probe, no real rebase needs to be in progress.
        mkdirSync(join(local, '.git', 'rebase-merge'));
        const host = makeMinimalHost(home, local);
        const result = runNomad(host, ['pull']);

        expect(result.status).toBe(EXIT.CONFLICT);
        expect(result.stderr).toContain('mid-rebase');
        expect(result.stderr).not.toContain('This looks like a bug');
        expect(listCrashDir(home)).toHaveLength(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
