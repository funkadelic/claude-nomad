import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from './exit-codes.ts';
import { buildPushRepo } from './test-support/git.ts';
import { runNomad, type Host } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. The CONFLICT
 * fixture below needs real git plumbing (a `.git/rebase-merge` marker
 * directory) inside a real repo, so gate that describe to skip cleanly on a
 * host without git rather than failing with an unhelpful spawn error.
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
 * Build a minimal `Host`-shaped env for `runNomad` around an existing repo
 * clone, without going through `makeWorld`/`nomad init` (this suite only
 * needs `nomad pull`'s own preflight, which `buildPushRepo`'s scaffold
 * already satisfies via `shared/settings.base.json`).
 *
 * @param home - Scratch HOME directory for the subprocess.
 * @param repo - Repository clone path to use as `NOMAD_REPO`.
 * @returns A `Host`-shaped object ready for `runNomad`.
 */
function makeMinimalHost(home: string, repo: string): Host {
  mkdirSync(home, { recursive: true });
  return {
    home,
    claudeHome: join(home, '.claude'),
    repo,
    hostname: 'exit-code-host',
    env: {
      ...process.env,
      HOME: home,
      NOMAD_REPO: repo,
      NOMAD_HOST: 'exit-code-host',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

describe('nomad process exit codes (subprocess, real dev entry)', () => {
  it('exits 0 on a successful invocation (--version)', () => {
    const home = mkdtempSync(join(tmpdir(), 'nomad-exitcode-version-'));
    const host = makeMinimalHost(home, join(home, 'unused-repo'));
    try {
      const result = runNomad(host, ['--version']);
      expect(result.status).toBe(EXIT.SUCCESS);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits 2 (USAGE) on an unknown subcommand', () => {
    const home = mkdtempSync(join(tmpdir(), 'nomad-exitcode-unknown-'));
    const host = makeMinimalHost(home, join(home, 'unused-repo'));
    try {
      const result = runNomad(host, ['bogus-subcommand']);
      expect(result.status).toBe(EXIT.USAGE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits 2 (USAGE) on a bad flag to a real subcommand', () => {
    const home = mkdtempSync(join(tmpdir(), 'nomad-exitcode-badflag-'));
    const host = makeMinimalHost(home, join(home, 'unused-repo'));
    try {
      const result = runNomad(host, ['pull', '--not-a-real-flag']);
      expect(result.status).toBe(EXIT.USAGE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe.skipIf(!hasGit)('wedged-repo pull (real git fixture)', () => {
    it('exits 4 (CONFLICT) on a mid-rebase wedged repo', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'nomad-exitcode-conflict-'));
      const home = mkdtempSync(join(tmpdir(), 'nomad-exitcode-conflict-home-'));
      try {
        const { local } = buildPushRepo(tmp);
        // Plant a mid-rebase marker directly: classifyWedge is a pure
        // marker-file probe (no real rebase needs to be in progress), the
        // same fixture shape commands/push/checks.test.ts uses for its preflight tests.
        mkdirSync(join(local, '.git', 'rebase-merge'));
        const host = makeMinimalHost(home, local);
        const result = runNomad(host, ['pull']);
        expect(result.status).toBe(EXIT.CONFLICT);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
