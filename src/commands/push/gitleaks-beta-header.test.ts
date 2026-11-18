import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanStagedTree } from './gitleaks.scan.ts';

/**
 * Real-binary suite for two `scanStagedTree` regressions: the bundled
 * oauth beta-flag allowlist, and a findings count large enough that verbose
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
      write(transcript, betasLine('interleaved-thinking-2025-05-14').repeat(20));
      expect(scanStagedTree(scanRoot)).toEqual([]);
    });

    it('still fires on a real token after the oauth flag', () => {
      write(transcript, betasLine(randomBytes(24).toString('base64url')));
      expect(scanStagedTree(scanRoot)?.length).toBe(1);
    });

    it('still fires on the beta-flag list outside a synced transcript', () => {
      write('shared/skills/demo/notes.md', betasLine('interleaved-thinking-2025-05-14'));
      expect(scanStagedTree(scanRoot)?.length).toBe(1);
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
