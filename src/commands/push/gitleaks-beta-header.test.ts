import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanFile, scanStagedTree } from './gitleaks.scan.ts';

/**
 * Real-binary suite for the bundled oauth beta-flag allowlist (push scan, the
 * redact re-scan, and with a user overlay) and for a findings count large
 * enough that verbose stdout would overflow the 1 MB `execFileSync` buffer.
 * Hermetic setup mirrors `gitleaks-memory-allowlist.test.ts`.
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

/** Deterministic github-pat-shaped token `i`, assembled at runtime. */
const patFor = (i: number): string => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const body = [...createHash('sha512').update(`k${i}`).digest()]
    .map((b) => abc[b % abc.length])
    .join('')
    .slice(0, 36);
  return ['gh', 'p_', body].join('');
};

/** A path-scoped overlay allowlist that matches nothing the suite scans. */
const overlayBody =
  "[[allowlists]]\nregexes = ['''zzunrelated''']\npaths = ['''^nothing/''']\ncondition = \"AND\"\n";

/** Env vars the suite isolates; USERPROFILE is the home on native Windows. */
const ISOLATED = [
  'HOME',
  'USERPROFILE',
  'NOMAD_REPO',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
];

describe.skipIf(!hasGitleaks)(
  'scanStagedTree beta header and large reports (real gitleaks)',
  () => {
    let saved: Record<string, string | undefined>;
    let testHome: string;
    let repoUnderHome: string;
    let scanRoot: string;

    beforeEach(() => {
      saved = Object.fromEntries(ISOLATED.map((k) => [k, process.env[k]]));
      for (const k of ISOLATED) delete process.env[k];
      testHome = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-beta-home-'));
      repoUnderHome = join(testHome, 'claude-nomad');
      mkdirSync(repoUnderHome, { recursive: true });
      const here = dirname(fileURLToPath(import.meta.url));
      copyFileSync(
        join(here, '..', '..', '..', '.gitleaks.toml'),
        join(repoUnderHome, '.gitleaks.toml'),
      );
      process.env.HOME = testHome;
      process.env.USERPROFILE = testHome;
      scanRoot = mkdtempSync(join(tmpdir(), 'nomad-gitleaks-beta-scan-'));
    });

    afterEach(() => {
      for (const k of ISOLATED) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
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

    it('keeps the suppression when a user overlay extends the bundled config', () => {
      // No repo-level .gitleaks.toml, so the overlay chains onto the bundled one.
      rmSync(join(repoUnderHome, '.gitleaks.toml'));
      writeFileSync(join(repoUnderHome, '.gitleaks.overlay.toml'), overlayBody);
      write(transcript, betasLine(flag).repeat(3));
      expect(scanStagedTree(scanRoot)).toEqual([]);
      // The push scan redacts Secret, so identify the surviving finding by line.
      write(transcript, betasLine(flag) + betasLine(realToken));
      expect(scanStagedTree(scanRoot)?.map((f) => f.StartLine)).toEqual([2]);
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

    it('keeps the redact re-scan suppression when a user overlay extends the bundled config', () => {
      rmSync(join(repoUnderHome, '.gitleaks.toml'));
      writeFileSync(join(repoUnderHome, '.gitleaks.overlay.toml'), overlayBody);
      const local = join(testHome, '.claude', 'projects', '-enc', 's.jsonl');
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, betasLine(flag) + betasLine(realToken));
      expect(scanFile(local)?.map((f) => f.Secret)).toEqual([realToken]);
    });

    it('still fires in the redact re-scan outside ~/.claude/projects', () => {
      write('elsewhere/s.jsonl', betasLine(flag));
      expect(scanFile(join(scanRoot, 'elsewhere', 's.jsonl'))?.length).toBe(1);
    });

    it('stages into the scan dir even when the caller exports GIT_INDEX_FILE', () => {
      const foreign = join(testHome, 'foreign-index');
      process.env.GIT_INDEX_FILE = foreign;
      write('notes/a.txt', 'hello\n');
      expect(scanStagedTree(scanRoot)).toEqual([]);
      expect(existsSync(foreign)).toBe(false);
    });

    it('returns every finding when the report is large', () => {
      // 5000 findings print about 1.4 MB under `-v`, past the old buffer limit.
      const n = 5000;
      const lines = Array.from({ length: n }, (_, i) => `token ${patFor(i)}`);
      write('notes/keys.txt', `${lines.join('\n')}\n`);
      expect(scanStagedTree(scanRoot)?.length).toBe(n);
    }, 60_000);
  },
);
