import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { failGlyph, okGlyph } from './color.ts';
import {
  type EnvSnapshot,
  type Section,
  GITLEAKS_TOML,
  makeEnv,
  PLANTED_SECRET,
  restoreEnv,
  saveEnv,
  writePathMap,
} from './commands.doctor.check-shared.test-helpers.ts';

/**
 * Probe once at suite-load whether a usable gitleaks binary is on PATH. The
 * real-binary clean/skip cases are wrapped in `describe.skipIf(!hasGitleaks)`
 * so local dev without gitleaks can still run the rest of the file while CI
 * (which installs gitleaks) runs everything.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGitleaks)('reportCheckShared (real binary, clean + skip)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    restoreEnv(snapshot, testHome);
  });

  it('renders one ok row reporting the scanned-project count and leaves exitCode 0 on a clean tree', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-clean.jsonl'),
      `{"role":"user","text":"nothing secret here"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const okRows = section.items.filter((r) => r.includes(okGlyph));
    expect(okRows).toHaveLength(1);
    expect(okRows[0]).toMatch(/\d+/);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('skips a project whose host entry is TBD (only mapped dirs reach the scan)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // The local dir holds a planted secret, but the path-map maps it to TBD for
    // this host, so it must be skipped (not scanned) and no finding surfaces.
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-tbd.jsonl'),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': 'TBD' } });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('renders an ok row and exits 0 when the only flagged content matches the .gitleaks.toml allowlist (D-10)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // Plant a documented test-fixture github-pat literal that the repo-root
    // .gitleaks.toml path-scoped allowlist drops for synced session paths
    // (condition = AND: a known literal AND a shared/projects/<logical>/*.jsonl
    // path). Default gitleaks rules flag the ghp_ shape, but with --config
    // pointing at the toml the match is allowlisted, so partitionFindings sees
    // zero sessions and reportCheckShared reports clean.
    const allowlisted = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-allowlist.jsonl'),
      `{"role":"user","text":"${allowlisted}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });
    // The harness HOME doubles as the repo root (REPO_HOME = ~/claude-nomad),
    // so writing the allowlist here makes reportCheckShared pass --config.
    writeFileSync(join(testHome, 'claude-nomad', '.gitleaks.toml'), GITLEAKS_TOML);

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const okRows = section.items.filter((r) => r.includes(okGlyph));
    expect(okRows).toHaveLength(1);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('removes the temp tree and report after a clean scan', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-cleanup.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const { readdirSync, existsSync } = await import('node:fs');
    const cacheDir = join(testHome, '.cache', 'claude-nomad');
    if (existsSync(cacheDir)) {
      const leftovers = readdirSync(cacheDir).filter((n) => n.startsWith('check-shared'));
      expect(leftovers).toEqual([]);
    }
  });
});
