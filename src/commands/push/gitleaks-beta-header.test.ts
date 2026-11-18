import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanFile, scanStagedTree } from './gitleaks.scan.ts';

/**
 * Real-binary suite for the bundled oauth beta-flag allowlist (push scan and
 * the redact re-scan) and for a findings count large enough that verbose
 * stdout would overflow the 1 MB `execFileSync` buffer. Hermetic setup mirrors
 * `gitleaks-memory-allowlist.test.ts`.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Fixed tokens, split so no contiguous secret-shaped literal is committed. */
const realToken = ['Qm7Vt2Kp9X', 'w4Zr8Ln3Hj', '6Bd1Fs5Gc0Ty'].join('');
const upperDated = ['Ab3xQ9Zr7Kp2', '-2025-05-14'].join('');
const flag = 'interleaved-thinking-2025-05-14';

/** A transcript line carrying the beta-flag list, with `next` after the oauth flag. */
const betasLine = (next: string): string =>
  `${JSON.stringify({ betas: ['claude-code-20250219', 'oauth-2025-04-20', next] })}\n`;

describe.skipIf(!hasGitleaks)(
  'scanStagedTree beta header and large reports (real gitleaks)',
  () => {
    let originalHome: string | undefined;
    let originalNomadRepo: string | undefined;
    let testHome: string;
    let scanRoot: string;

    beforeEach(() => {
      originalHome = process.env.HOME;
      originalNomadRepo = process.env.NOMAD_REPO;
      testHome = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-beta-home-'));
      const repoUnderHome = join(testHome, 'claude-nomad');
      mkdirSync(repoUnderHome, { recursive: true });
      const here = dirname(fileURLToPath(import.meta.url));
      copyFileSync(
        join(here, '..', '..', '..', '.gitleaks.toml'),
        join(repoUnderHome, '.gitleaks.toml'),
      );
      process.env.HOME = testHome;
      delete process.env.NOMAD_REPO;
      scanRoot = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-beta-scan-'));
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
      else delete process.env.NOMAD_REPO;
      rmSync(testHome, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    });

    /** Write `body` at `rel` under `scanRoot`. */
    function write(rel: string, body: string): void {
      const p = join(scanRoot, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }

    const transcript = 'shared/projects/testproj/s.jsonl';

    it('suppresses the oauth beta-flag list in a synced transcript', () => {
      write(transcript, betasLine(flag).repeat(20));
      expect(scanStagedTree(scanRoot)).toEqual([]);
    });

    it.each([
      ['a real token', realToken],
      ['an uppercase date-suffixed token', upperDated],
    ])('still fires on %s after the oauth flag', (_label, next) => {
      write(transcript, betasLine(next));
      expect(scanStagedTree(scanRoot)?.length).toBe(1);
    });

    it('still fires on the beta-flag list outside a synced transcript', () => {
      write('shared/skills/demo/notes.md', betasLine(flag));
      expect(scanStagedTree(scanRoot)?.length).toBe(1);
    });

    it('suppresses the beta-flag list in the redact re-scan of a local transcript', () => {
      const local = join(testHome, '.claude', 'projects', '-enc', 's.jsonl');
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, betasLine(flag) + betasLine(realToken));
      expect(scanFile(local)?.map((f) => f.Secret)).toEqual([realToken]);
    });

    it('still fires in the redact re-scan outside ~/.claude/projects', () => {
      write('elsewhere/s.jsonl', betasLine(flag));
      expect(scanFile(join(scanRoot, 'elsewhere', 's.jsonl'))?.length).toBe(1);
    });

    it('returns every finding when the report is large', () => {
      const n = 5000;
      const lines = Array.from(
        { length: n },
        () => `api_key = "${randomBytes(24).toString('hex')}"`,
      );
      write('notes/keys.txt', `${lines.join('\n')}\n`);
      // A few random keys fall under the entropy threshold; the regression is `null`.
      expect(scanStagedTree(scanRoot)?.length).toBeGreaterThan(n * 0.9);
    }, 60_000);
  },
);
