import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph, okGlyph } from './color.ts';
import { type PathMap } from './config.ts';

/**
 * Probe once at suite-load whether a usable gitleaks binary is on PATH. Only
 * the real-binary integration cases need it; they are wrapped in
 * `describe.skipIf(!hasGitleaks)` so local dev without gitleaks can still run
 * the rest of the file while CI (which installs gitleaks) runs everything.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Shape of the section reportCheckShared appends rows to (mirrors DoctorSection). */
type Section = { header: string; items: string[] };

/**
 * Local shim for the module under test so the dynamic import destructures
 * cleanly under @typescript-eslint/no-unsafe-*. Mirrors the expected signature;
 * the production type in commands.doctor.check-shared.ts is the real contract.
 */
type CheckSharedModule = { reportCheckShared: (section: Section) => void };

/** Local shim for the SESSION_PATH regex re-imported in the fidelity case. */
type PushGitleaksModule = { SESSION_PATH: RegExp };

/**
 * Build a sandbox HOME for a check-shared run: a temp `HOME` with the
 * `claude-nomad/` repo skeleton and a `.claude/projects/<encoded>/` session
 * dir. Returns the temp dir and the absolute local project path so callers can
 * write a path-map entry and a session JSONL. `encodePath` is `/` -> `-`.
 */
function makeEnv(): { testHome: string; localPath: string; encodedDir: string } {
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-check-shared-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  mkdirSync(join(testHome, 'claude-nomad', 'shared'), { recursive: true });
  const localPath = '/srv/foo';
  const encodedDir = localPath.replaceAll('/', '-');
  mkdirSync(join(testHome, '.claude', 'projects', encodedDir), { recursive: true });
  return { testHome, localPath, encodedDir };
}

/** Write a path-map.json mapping `logical` -> { test-host: localPath }. */
function writePathMap(testHome: string, projects: PathMap['projects']): void {
  writeFileSync(
    join(testHome, 'claude-nomad', 'path-map.json'),
    JSON.stringify({ projects }) + '\n',
  );
}

/** A planted AWS access key id, recognized by default gitleaks rules. Assembled
 * at runtime so a contiguous AKIA token never sits in source-controlled bytes. */
const PLANTED_SECRET = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

describe.skipIf(!hasGitleaks)('reportCheckShared (real binary)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.exitCode = 0;
    vi.resetModules();
    // Suppress the utils.log `ℹ︎ skip ...` lines copyDirJsonlOnly emits during
    // the temp-tree build so the test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {
      // Capture only.
    });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits a fail row naming the session id and RuleID count and sets exitCode=1 on a planted secret', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    const sid = 'sid-with-secret';
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain(failGlyph);
    expect(rows).toContain(sid);
    expect(rows).toMatch(/\(\d+\)/);
    expect(process.exitCode).toBe(1);
  });

  it('renders rotate-and-scrub guidance naming the live session path plus an allowlist hint', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    const sid = 'sid-guidance';
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain('rotate');
    expect(rows).toContain(join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`));
    expect(rows).toContain('.gitleaks.toml');
  });

  it('matches the recovered finding File against SESSION_PATH (positional dir invocation fidelity)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    const sid = 'sid-fidelity';
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
    const { SESSION_PATH } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    // The session id surfaces only when a finding File matched SESSION_PATH and
    // partitionFindings keyed it; the recovered File reads
    // shared/projects/foo/<sid>.jsonl, which the regex captures.
    const reconstructed = `shared/projects/foo/${sid}.jsonl`;
    expect(SESSION_PATH.test(reconstructed)).toBe(true);
    expect(section.items.join('\n')).toContain(sid);
    expect(process.exitCode).toBe(1);
  });

  it('renders one ok row reporting the scanned-session count and leaves exitCode 0 on a clean tree', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-clean.jsonl'),
      `{"role":"user","text":"nothing secret here"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const okRows = section.items.filter((r) => r.includes(okGlyph));
    expect(okRows.length).toBe(1);
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

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

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

    const { reportCheckShared } =
      (await import('./commands.doctor.check-shared.ts')) as CheckSharedModule;
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
