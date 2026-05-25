import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
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

/** A planted GitHub PAT (ghp_ + 36 chars), reliably flagged by default gitleaks
 * rules. Assembled at runtime so a contiguous PAT-shaped token never sits in
 * source-controlled bytes. Distinct body from the documented test-fixture
 * literal so the path-scoped allowlist does not swallow it. */
const PLANTED_SECRET = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');

/**
 * Minimal .gitleaks.toml written into the fixture REPO_HOME for the
 * allowlist-only case. Carries the path-scoped allowlist (condition = AND) that
 * drops the documented test-fixture github-pat literal when it appears at a
 * `shared/projects/<logical>/*.jsonl` path. The literal is split so no
 * contiguous PAT-shaped token sits in source-controlled bytes.
 */
const GITLEAKS_TOML = `[extend]
useDefault = true

[[allowlists]]
description = "test-fixture github-pat literals in synced session transcripts"
regexes = [
    '''${['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('')}''',
]
paths = [
    '''^shared/projects/[^/]+/.*\\.jsonl$''',
]
condition = "AND"
`;

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

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain(failGlyph);
    expect(rows).toContain(sid);
    expect(rows).toMatch(/\(\d+\)/);
    expect(process.exitCode).toBe(1);
  });

  it('flags a flat-session secret that gitleaks dir missed under a path-scoped AND allowlist (scan parity regression)', async () => {
    // The bug: with a repo .gitleaks.toml carrying a path-scoped
    // `condition = "AND"` allowlist (a known literal AND a
    // shared/projects/<logical>/*.jsonl path), the old `gitleaks dir`
    // preflight reported "no leaks" (exit 0) on a NON-allowlisted secret at
    // such a path, while `gitleaks push protect --staged` (the push gate)
    // flagged it. Routing the preflight through the shared scanStagedTree
    // (protect --staged) closes the gap. PLANTED_SECRET has a distinct 36-char
    // body from the allowlisted literals, so it is a real finding that must
    // fire; the allowlist's mere presence is what triggered the dir miss.
    const env = makeEnv();
    testHome = env.testHome;
    const sid = 'sid-parity';
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });
    // The harness HOME doubles as REPO_HOME, so writing the toml here makes the
    // shared scan pass --config and reproduces the dir-vs-protect divergence.
    writeFileSync(join(testHome, 'claude-nomad', '.gitleaks.toml'), GITLEAKS_TOML);

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain(failGlyph);
    expect(rows).toContain(sid);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
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

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(rows).toContain('rotate');
    expect(rows).toContain(join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`));
    expect(rows).toContain('.gitleaks.toml');
  });

  it('matches the recovered finding File against SESSION_PATH', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    const sid = 'sid-fidelity';
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, `${sid}.jsonl`),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const { SESSION_PATH } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    // The session id surfaces only when a finding File matched SESSION_PATH and
    // partitionFindings keyed it; the recovered File reads
    // shared/projects/foo/<sid>.jsonl, which the regex captures. The scan now
    // runs via protect --staged (scanStagedTree), not a positional dir scan.
    const reconstructed = `shared/projects/foo/${sid}.jsonl`;
    expect(SESSION_PATH.test(reconstructed)).toBe(true);
    expect(section.items.join('\n')).toContain(sid);
    expect(process.exitCode).toBe(1);
  });

  it('fails on a nested non-session transcript secret that lands in the other bucket and sets exitCode=1', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // copyDirJsonlOnly filters *.jsonl only at depth 0; subdirectories copy
    // recursively unfiltered, so a secret in subagents/<id>.jsonl (depth 4)
    // does NOT match the flat SESSION_PATH and is routed to partitionFindings'
    // `other` bucket. push would stage this file, so the preflight must fail
    // too. A bySession-only gate would report this clean.
    const nestedDir = join(testHome, '.claude', 'projects', env.encodedDir, 'subagents');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, 'nested-agent.jsonl'),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    // The fail row names the offending repo-relative nested path, not a session.
    expect(rows).toContain('subagents/nested-agent.jsonl');
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
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
    expect(okRows.length).toBe(1);
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

/**
 * Mocked `node:child_process` cases (no real gitleaks needed): the two
 * exit-code-matrix endpoints that cannot be driven by a real binary, namely
 * gitleaks-missing (D-09, ENOENT on the probe) and the unparseable-report fail
 * (D-10, non-zero exit with no readable report). Every `vi.doMock` here is
 * paired with a `vi.doUnmock` in `afterEach` because `vi.restoreAllMocks` does
 * NOT clear `vi.doMock` module mocks (they would otherwise leak across files).
 */
describe('reportCheckShared (mocked child_process)', () => {
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
    vi.spyOn(console, 'log').mockImplementation(() => {
      // Capture only; suppress copyDirJsonlOnly skip lines.
    });
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    // Pair every doMock with a doUnmock; restoreAllMocks does NOT clear doMock
    // module mocks, so an unpaired mock would leak into later files.
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits exactly one warn row and leaves exitCode 0 when the gitleaks probe throws ENOENT (D-09)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A planted secret + valid map would normally fail; the missing-binary
    // probe must short-circuit BEFORE any scan, so the leak is never reached.
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-no-gitleaks.jsonl'),
      `{"role":"user","text":"${PLANTED_SECRET}"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // probeGitleaks calls execFileSync('gitleaks', ['version', ...]); throw
        // an ENOENT-coded error to simulate the binary being absent from PATH.
        execFileSync: vi.fn(() => {
          throw Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' });
        }),
      };
    });

    expect(process.exitCode).toBe(0);
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const warnRows = section.items.filter((r) => r.includes(warnGlyph));
    expect(warnRows.length).toBe(1);
    expect(warnRows[0]).toMatch(/skip/i);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('emits a scan-failed fail row, exits 1, and writes no session row when the report is unparseable (D-10)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-unparseable.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          // The gitleaks `version` probe and the git init/add stage must succeed
          // so the flow reaches the scan; only the protect --staged scan fails.
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged exits non-zero WITHOUT writing any report
          // at --report-path, so readGitleaksReport returns null (the unparseable
          // signal) and the reporter reports scan-failed rather than chasing
          // phantom sessions.
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    expect(process.exitCode).toBe(0);
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(rows).toMatch(/scan failed/i);
    expect(rows).not.toContain('session ');
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('degrades a malformed path-map.json to a FAIL row and exit 1 without throwing', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A malformed path-map.json: readJson (raw JSON.parse) would throw a
    // SyntaxError. The reporter must catch it, emit a FAIL row, and set
    // exitCode 1 rather than letting the error propagate and abort doctor.
    writeFileSync(join(testHome, 'claude-nomad', 'path-map.json'), '{ this is not valid json');

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // The version probe must succeed so the flow reaches the path-map read.
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          return Buffer.from('');
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    expect(() => {
      reportCheckShared(section);
    }).not.toThrow();

    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('emits a probe-failed FAIL row (not a not-on-PATH skip) when the gitleaks probe fails with EACCES', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-eacces.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // A permission error (corrupt binary / bad perms), NOT ENOENT. The
        // reporter must distinguish this from missing-on-PATH (which is a WARN
        // skip) and report a FAIL with the underlying message, mirroring
        // reportGitleaksProbe.
        execFileSync: vi.fn(() => {
          throw Object.assign(new Error('spawn gitleaks EACCES'), { code: 'EACCES' });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(true);
    expect(section.items.some((r) => r.includes(warnGlyph))).toBe(false);
    expect(rows).toMatch(/EACCES/);
    expect(process.exitCode).toBe(1);
  });

  it('emits one scan-failed fail row and exits 1 when scanStagedTree throws a non-ENOENT error', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A real session dir maps to this host so buildScanTree stages it
    // (staged > 0) and the flow reaches scanStagedTree inside the inner try.
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-scan-throw.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    // scanStagedTree swallows non-ENOENT execFileSync failures, so drive the
    // error from its pre-try `mkdirSync(cacheDir)`. reportCheckShared also
    // mkdirs that same cacheDir once before the scan, so throw only on the
    // SECOND cacheDir mkdir (scanStagedTree's), leaving the reporter's own
    // setup intact. The non-ENOENT error then escapes scanStagedTree into the
    // reporter's inner catch (the scan-failed fail row + exitCode 1).
    let cacheMkdirs = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        mkdirSync: vi.fn((p: fsModule.PathLike, o?: fsModule.MakeDirectoryOptions) => {
          if (String(p).includes(join('.cache', 'claude-nomad'))) {
            cacheMkdirs++;
            if (cacheMkdirs >= 2) {
              throw Object.assign(new Error('mkdir cache failed: disk error'), { code: 'EIO' });
            }
          }
          return actual.mkdirSync(p, o);
        }),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // The version probe must succeed so the flow reaches the scan; the
        // mkdirSync throw above fires before any git/gitleaks call.
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const failRows = section.items.filter((r) => r.includes(failGlyph));
    expect(failRows.length).toBe(1);
    expect(failRows[0]).toMatch(/scan failed: .*disk error/);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('never leaks gitleaks stderr/stdout into the scan-failed row when protect --staged fails', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-scanmsg.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const secretInStreams = 'TOP_SECRET_STREAM_CONTENT';
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          // git init / git add succeed; only the protect --staged scan fails.
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged fails and carries stderr/stdout that must
          // never reach the doctor row (the shared scanStagedTree is called with
          // forwardStreams=false, so the streams are dropped entirely).
          throw Object.assign(new Error('gitleaks protect exited 126: bad invocation'), {
            status: 126,
            stderr: Buffer.from(secretInStreams),
            stdout: Buffer.from(secretInStreams),
          });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    // No report was written, so the helper returns null and the doctor reports a
    // scan-failed row. The redacted-but-sensitive streams must never appear.
    expect(rows).toMatch(/scan failed/i);
    expect(rows).not.toContain(secretInStreams);
    expect(process.exitCode).toBe(1);
  });

  it('removes the temp report and temp tree in finally on the failure path (D-04)', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-fail-cleanup.jsonl'),
      `{"role":"user","text":"benign content"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    const rmCalls: { path: string; opts: unknown }[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        // Record every removal so we can assert the finally block removed both
        // the report file ({ force: true }) and the temp tree ({ recursive:
        // true, force: true }); still delegate to the real rmSync so the disk
        // is actually cleaned.
        rmSync: vi.fn((p: fsModule.PathLike, o?: fsModule.RmOptions) => {
          rmCalls.push({ path: String(p), opts: o });
          actual.rmSync(p, o);
        }),
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { existsSync } = await import('node:fs');
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(process.exitCode).toBe(1);
    const reportRm = rmCalls.find(
      (c) => c.path.includes('check-shared-') && c.path.endsWith('.json'),
    );
    const treeRm = rmCalls.find((c) => c.path.includes('check-shared-tree-'));
    expect(reportRm).toBeDefined();
    expect(reportRm?.opts).toMatchObject({ force: true });
    expect(treeRm).toBeDefined();
    expect(treeRm?.opts).toMatchObject({ recursive: true, force: true });
    // The artifacts must be gone from disk after the run.
    expect(reportRm && existsSync(reportRm.path)).toBeFalsy();
    expect(treeRm && existsSync(treeRm.path)).toBeFalsy();
  });

  it('reports clean with zero scanned when no path-map.json exists', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // No path-map.json written: buildScanTree finds nothing to stage, so the
    // reporter short-circuits to a clean "0 project(s)" row without scanning.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? [])[0] === 'version') return Buffer.from('8.0.0');
          throw new Error('scan must not run when nothing is staged');
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('reports clean with zero scanned when path-map projects is not an object', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // A structurally valid JSON whose `projects` is a non-object: buildScanTree
    // treats it as empty (no crash) and the reporter emits a clean 0 row.
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: 'nope' }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('skips a project whose host map is not an object and reports clean zero', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    // `projects.foo` is a string, not a { host: path } object: buildScanTree
    // skips it (continue) rather than throwing, leaving nothing staged.
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: { foo: 'not-an-object' } }) + '\n',
    );
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) =>
          (args ?? [])[0] === 'version' ? Buffer.from('8.0.0') : Buffer.from(''),
        ),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('0 project'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('reports clean when a non-zero scan still writes an empty findings report', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-empty.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          // gitleaks protect --staged exits non-zero but writes a parseable
          // empty array: both partition buckets are empty, so the reporter emits
          // the clean row (staged count) rather than a phantom-session fail.
          const rp = list.find((a) => a.startsWith('--report-path='));
          if (rp) writeFileSync(rp.slice('--report-path='.length), '[]');
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    expect(section.items.some((r) => r.includes(okGlyph) && r.includes('1 project'))).toBe(true);
    expect(section.items.some((r) => r.includes(failGlyph))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('emits both an other-bucket leak row and per-session rows when findings mix session and nested paths', async () => {
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'sid-mixed.jsonl'),
      `{"role":"user","text":"benign"}\n`,
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });

    // Two findings share session `sid-1` (exercises the duplicate-sid path in
    // the logical-name capture) and one is a nested path that matches neither
    // the flat SESSION_PATH nor any session (the `other` bucket).
    const report = JSON.stringify([
      {
        RuleID: 'aws-access-key',
        File: 'shared/projects/foo/sid-1.jsonl',
        StartLine: 1,
        Match: 'REDACTED',
        Fingerprint: 'fp-a',
      },
      {
        RuleID: 'github-pat',
        File: 'shared/projects/foo/sid-1.jsonl',
        StartLine: 2,
        Match: 'REDACTED',
        Fingerprint: 'fp-b',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/subagents/nested.jsonl',
        StartLine: 1,
        Match: 'REDACTED',
        Fingerprint: 'fp-c',
      },
    ]);
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const list = args ?? [];
          if (list[0] === 'version') return Buffer.from('8.0.0');
          if (list[0] === 'init' || list[0] === 'add') return Buffer.from('');
          const rp = list.find((a) => a.startsWith('--report-path='));
          if (rp) writeFileSync(rp.slice('--report-path='.length), report);
          throw Object.assign(new Error('gitleaks exited 1'), { status: 1 });
        }),
      };
    });

    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const section: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(section);

    const rows = section.items.join('\n');
    // Session row carries both RuleID counts for sid-1.
    expect(rows).toMatch(/session sid-1:.*aws-access-key \(1\)/);
    expect(rows).toContain('github-pat (1)');
    // Other-bucket row names the nested path and its RuleID.
    expect(rows).toContain('leak in shared/projects/foo/subagents/nested.jsonl: generic-api-key');
    // The scrub hint reuses the captured logical/encoded mapping.
    expect(rows).toMatch(/rotate the credential, then scrub .*sid-1\.jsonl/);
    expect(section.items.some((r) => r.includes(okGlyph))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
