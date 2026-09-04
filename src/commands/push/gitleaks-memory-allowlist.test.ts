import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanStagedTree } from './gitleaks.scan.ts';

/**
 * Real-binary regression suite pinning the scope of the `.gitleaks.toml`
 * widening: the documented github-pat fixture block and the SSH public-key
 * fingerprint block now also match `shared/projects/<logical>/memory/*.md`,
 * while the structurally tool-output-only blocks (noise fingerprints,
 * SonarCloud issue-listing) stay `.jsonl`-scoped. Proves both halves of the
 * change: real structural noise is suppressed under `memory/*.md`, and a
 * genuine credential (or block-1-shaped tool-output noise) in the same
 * location still fires, so the widening cannot silently swallow a real leak.
 *
 * Copies the worktree's `.gitleaks.toml` into a fake `REPO_HOME` under a temp
 * `HOME` (mirroring the hermetic pattern in `push-gitleaks.test.ts`) so the
 * scan loads the just-edited allowlist regardless of the developer machine's
 * real `~/claude-nomad/.gitleaks.overlay.toml` state. Scans via
 * `scanStagedTree` (`gitleaks protect --staged`), the same mechanism `nomad
 * push` uses, not `gitleaks dir`, since the two apply the path-scoped
 * `condition = "AND"` allowlist differently. Gated on the real gitleaks
 * binary so local dev/CI without it still runs the rest of the suite.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Assemble a github-pat-shaped fixture token from fragments so no contiguous
 * `ghp_<36>` literal is stored in source-controlled bytes (the gitleaks CI
 * check scans the working tree and would flag a committed PAT-shaped
 * literal). Mirrors the split-fragment convention in `commands.redact.test.ts`
 * and `push-gitleaks.test.ts`.
 *
 * @param body The 36-char token body that follows the `ghp_` prefix.
 * @returns A `ghp_`-prefixed token assembled at runtime.
 */
const ghpFixture = (body: string): string => ['gh', 'p_', body].join('');

/**
 * Assemble an `AY`-prefixed, block-1-shaped token from fragments so no
 * contiguous high-entropy `AY<20+>` literal is stored in source-controlled
 * bytes (the gitleaks CI check scans the working tree and would flag the
 * literal, which the transcript-scoped allowlist does not suppress outside a
 * synced path). Same split-fragment convention as `ghpFixture`.
 *
 * @param body The url-safe token body that follows the `AY` prefix.
 * @returns An `AY`-prefixed token assembled at runtime.
 */
const ayFixture = (body: string): string => ['A', 'Y', body].join('');

describe.skipIf(!hasGitleaks)(
  '.gitleaks.toml memory/*.md allowlist widening (real gitleaks)',
  () => {
    let originalHome: string | undefined;
    let originalNomadRepo: string | undefined;
    let testHome: string;
    let scanRoot: string;

    beforeEach(() => {
      originalHome = process.env.HOME;
      originalNomadRepo = process.env.NOMAD_REPO;
      testHome = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-memory-home-'));
      const repoUnderHome = join(testHome, 'claude-nomad');
      mkdirSync(repoUnderHome, { recursive: true });
      // Copy the worktree's just-edited .gitleaks.toml into the fake
      // REPO_HOME so the real gitleaks subprocess loads the production
      // allowlist via --config, hermetically (S-01 precedence: a full
      // REPO_HOME/.gitleaks.toml wins over any overlay on the real machine).
      const here = dirname(fileURLToPath(import.meta.url));
      copyFileSync(
        join(here, '..', '..', '..', '.gitleaks.toml'),
        join(repoUnderHome, '.gitleaks.toml'),
      );
      process.env.HOME = testHome;
      delete process.env.NOMAD_REPO;
      scanRoot = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-memory-scan-'));
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
      rmSync(testHome, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    });

    /** Write `body` as `shared/projects/testproj/memory/notes.md` in `scanRoot`. */
    function writeMemoryFile(body: string): void {
      const memDir = join(scanRoot, 'shared', 'projects', 'testproj', 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, 'notes.md'), body);
    }

    it('suppresses the documented block-2 github-pat fixture literal in memory/*.md', () => {
      writeMemoryFile(
        `# Notes\n\nDocumented fixture literal: ${ghpFixture('xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA')}\n`,
      );
      const findings = scanStagedTree(scanRoot);
      expect(findings).toEqual([]);
    });

    it('suppresses a block-3 SSH public-key fingerprint line in memory/*.md', () => {
      writeMemoryFile(`Good "git" signature for norm with ED25519 key SHA256:${'A'.repeat(43)}\n`);
      const findings = scanStagedTree(scanRoot);
      expect(findings).toEqual([]);
    });

    it('still fires on a different high-entropy PAT in the same memory/*.md file', () => {
      writeMemoryFile(`Distinct PAT: ${ghpFixture('0123456789abcdefghijABCDEFGHIJ012345')}\n`);
      const findings = scanStagedTree(scanRoot);
      expect(findings).not.toBeNull();
      expect((findings ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it('does not suppress a block-1-shaped AY token in memory/*.md (block 1 stays jsonl-only)', () => {
      // A `key = "AY<20 chars>"` value is genuinely suppressed by block 1 under
      // a `.jsonl` path (empirically verified: the same content produces zero
      // findings there), so if the widening had accidentally leaked block 1's
      // path scope onto `memory/*.md`, this would also come back suppressed.
      // Placed under `memory/*.md` (never widened), it must still fire.
      writeMemoryFile(`key = "${ayFixture('NbrnTP3fAbnFbmOHnKYa')}"\n`);
      const findings = scanStagedTree(scanRoot);
      expect(findings).not.toBeNull();
      expect((findings ?? []).length).toBeGreaterThanOrEqual(1);
    });
  },
);
