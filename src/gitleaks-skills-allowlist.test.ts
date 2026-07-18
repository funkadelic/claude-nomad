import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanStagedTree } from './push-gitleaks.scan.ts';

/**
 * Real-binary regression suite pinning the scope of the `.gitleaks.toml`
 * skills widening: the structurally-ANCHORED noise blocks (gitleaks
 * fingerprints / npm-audit id / coverage line-keys, SSH public-key
 * fingerprints, SonarCloud issue-listing) now also match
 * `shared/skills/<name>/**` (recursively, any nesting depth), while the
 * documented github-pat fixture block AND the bare `AY` Sonar-issue-key token
 * shape stay deliberately unwidened (transcript-only). The `AY` shape is
 * context-free, so widening it to executable skill content could mask a real
 * `AY`-prefixed credential; it lives in its own transcript-only block.
 * Proves every half of the change: structurally-anchored noise is suppressed
 * under `shared/skills/**`, while a genuine credential (a high-entropy
 * `AY`-shaped token OR a github-pat) in the same tree still fires, so the
 * widening cannot silently swallow a real leak.
 *
 * Copies the worktree's `.gitleaks.toml` into a fake `REPO_HOME` under a temp
 * `HOME` (mirroring the hermetic pattern in `gitleaks-memory-allowlist.test.ts`)
 * so the scan loads the just-edited allowlist regardless of the developer
 * machine's real `~/claude-nomad/.gitleaks.overlay.toml` state. Scans via
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
 * literal). Mirrors the split-fragment convention in
 * `gitleaks-memory-allowlist.test.ts` and `push-gitleaks.test.ts`.
 *
 * @param body The 36-char token body that follows the `ghp_` prefix.
 * @returns A `ghp_`-prefixed token assembled at runtime.
 */
const ghpFixture = (body: string): string => ['gh', 'p_', body].join('');

/**
 * Assemble an `AY`-prefixed, block-1-shaped token from fragments so no
 * contiguous high-entropy `AY<20+>` literal is stored in source-controlled
 * bytes. Same split-fragment convention as `ghpFixture`.
 *
 * @param body The url-safe token body that follows the `AY` prefix.
 * @returns An `AY`-prefixed token assembled at runtime.
 */
const ayFixture = (body: string): string => ['A', 'Y', body].join('');

describe.skipIf(!hasGitleaks)(
  '.gitleaks.toml shared/skills/** allowlist widening (real gitleaks)',
  () => {
    let originalHome: string | undefined;
    let originalNomadRepo: string | undefined;
    let testHome: string;
    let scanRoot: string;

    beforeEach(() => {
      originalHome = process.env.HOME;
      originalNomadRepo = process.env.NOMAD_REPO;
      testHome = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-skills-home-'));
      const repoUnderHome = join(testHome, 'claude-nomad');
      mkdirSync(repoUnderHome, { recursive: true });
      // Copy the worktree's just-edited .gitleaks.toml into the fake
      // REPO_HOME so the real gitleaks subprocess loads the production
      // allowlist via --config, hermetically (S-01 precedence: a full
      // REPO_HOME/.gitleaks.toml wins over any overlay on the real machine).
      const here = dirname(fileURLToPath(import.meta.url));
      copyFileSync(join(here, '..', '.gitleaks.toml'), join(repoUnderHome, '.gitleaks.toml'));
      process.env.HOME = testHome;
      delete process.env.NOMAD_REPO;
      scanRoot = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-skills-scan-'));
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
      rmSync(testHome, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    });

    /** Write `body` as `shared/skills/<name>/<relPath>` in `scanRoot`. */
    function writeSkillFile(name: string, relPath: string, body: string): void {
      const filePath = join(scanRoot, 'shared', 'skills', name, relPath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }

    it('suppresses a structurally-anchored gitleaks-fingerprint noise shape under a nested skill path', () => {
      // Nested relPath (references/notes.md) proves the recursive anchor
      // `^shared/skills/[^/]+/.*$` covers arbitrary nesting depth, unlike the
      // flat memory anchor. The `<path>.<ext>:<rule>:<line>` shape carries
      // structural context, so it is safe to suppress under skills.
      writeSkillFile(
        'myskill',
        'references/notes.md',
        'gitleaks fingerprint: src/foo.ts:my-rule:42\n',
      );
      const findings = scanStagedTree(scanRoot);
      expect(findings).toEqual([]);
    });

    it('still fires on a standalone high-entropy AY-shaped token under shared/skills/** (AY block not widened to skills)', () => {
      // The bare `AY`-prefixed token shape is context-free and matches the
      // transcript-only Sonar-issue-key allowlist regex, but that block is NOT
      // scoped to skills. A real `AY`-shaped credential pasted into executable
      // skill content must therefore still fire, or the skills-parity purpose
      // of this PR would be defeated. Deterministic high-entropy body assembled
      // at runtime from short fragments: no contiguous `AY<20>` literal (nor a
      // high-entropy 20-char literal) is stored in source-controlled bytes, so
      // the gitleaks CI self-scan cannot flag this test file, yet the token is
      // reproducible rather than a probabilistic random draw.
      const body = ['xK7p', 'Qm2v', 'Rt9w', 'Zb4n', 'Yc5d'].join('');
      writeSkillFile('myskill', 'SKILL.md', `api_key = "${ayFixture(body)}"\n`);
      const findings = scanStagedTree(scanRoot);
      expect(findings).not.toBeNull();
      expect((findings ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it('suppresses a block-3 SSH public-key fingerprint line under shared/skills/**', () => {
      writeSkillFile(
        'myskill',
        'SKILL.md',
        `Good "git" signature for norm with ED25519 key SHA256:${'A'.repeat(43)}\n`,
      );
      const findings = scanStagedTree(scanRoot);
      expect(findings).toEqual([]);
    });

    it('suppresses a block-4 SonarCloud issue-listing pair under shared/skills/**', () => {
      // Block 4's regex looks for a literal two-character `\n` sequence (not
      // an actual line break) between the `key:` and `rule:` tokens, matching
      // how this shape is embedded in JSON-escaped session transcript text.
      // Built via string concatenation (not a template-literal escape) so the
      // literal two-char sequence is unambiguous in source.
      const line = 'key: ' + ayFixture('abcdefghijklmnopqrst') + '\\n  rule: typescript:S1234\n';
      writeSkillFile('myskill', 'SKILL.md', line);
      const findings = scanStagedTree(scanRoot);
      expect(findings).toEqual([]);
    });

    it('still fires on the documented block-2 github-pat fixture literal under shared/skills/** (block 2 not widened)', () => {
      writeSkillFile(
        'myskill',
        'SKILL.md',
        `Documented fixture literal: ${ghpFixture('xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA')}\n`,
      );
      const findings = scanStagedTree(scanRoot);
      expect(findings).not.toBeNull();
      expect((findings ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it('still fires on a different high-entropy PAT under shared/skills/**', () => {
      writeSkillFile(
        'myskill',
        'SKILL.md',
        `Distinct PAT: ${ghpFixture('0123456789abcdefghijABCDEFGHIJ012345')}\n`,
      );
      const findings = scanStagedTree(scanRoot);
      expect(findings).not.toBeNull();
      expect((findings ?? []).length).toBeGreaterThanOrEqual(1);
    });
  },
);
