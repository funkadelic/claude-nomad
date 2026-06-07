import { execFileSync } from 'node:child_process';
import type * as cpModule from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** Local shim for the SESSION_PATH regex re-imported in the fidelity case. */
type PushGitleaksModule = { SESSION_PATH: RegExp };

describe.skipIf(!hasGitleaks)('reportCheckShared (real binary)', () => {
  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    restoreEnv(snapshot, testHome);
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
    const { mkdirSync } = await import('node:fs');
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
});

describe('reportCheckShared buildScanTree unit tests (gitleaks mocked)', () => {
  // These tests exercise the buildScanTree logic (path-map guard, staged counter,
  // TBD skip, projects null/array guard, hosts null guard) without a real gitleaks
  // binary. The approach:
  //   1. Mock execFileSync so gitleaks version probe returns a fake version.
  //   2. Mock scanAndReport from the scan sibling so the actual gitleaks scan
  //      is not invoked; the mock records the `staged` count passed to it.
  // This lets tests assert directly on the staging logic.

  let snapshot: EnvSnapshot;
  let testHome: string;

  beforeEach(() => {
    snapshot = saveEnv();
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commands.doctor.check-shared.scan.ts');
    restoreEnv(snapshot, testHome);
  });

  /**
   * Configure the gitleaks probe mock so ensureGitleaksReady returns true, and
   * capture scanAndReport call arguments via a spy.
   *
   * @returns A function that returns the `staged` count from the most recent
   *   scanAndReport call, or -1 if it was never called.
   */
  function mockGitleaksAndCaptureScanArgs(): () => number {
    let capturedStaged = -1;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (
            bin: string,
            args: readonly string[],
            opts?: Parameters<typeof cpModule.execFileSync>[2],
          ) => {
            if (bin === 'gitleaks' && args[0] === 'version') {
              return Buffer.from('v8.18.2\n');
            }
            return actual.execFileSync(bin, args, opts);
          },
        ),
      };
    });
    vi.doMock('./commands.doctor.check-shared.scan.ts', async (importOriginal) => {
      const actual =
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        await importOriginal<typeof import('./commands.doctor.check-shared.scan.ts')>();
      return {
        ...actual,
        scanAndReport: vi.fn((_section: Section, _tmpRoot: string, staged: number) => {
          capturedStaged = staged;
        }),
      };
    });
    vi.resetModules();
    return () => capturedStaged;
  }

  it('emits a clean row (staged=0) when path-map.json is absent', async () => {
    // No path-map.json -> buildScanTree returns staged=0 -> emitClean, no scan.
    const env = makeEnv();
    testHome = env.testHome;
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('emits a fail row and sets exitCode=1 when path-map.json is malformed JSON', async () => {
    // Kills the malformed-JSON guard: a SyntaxError from readJson must produce a
    // FAIL row instead of propagating as an unhandled exception.
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(join(testHome, 'claude-nomad', 'path-map.json'), 'not-json\n');
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    const rows = sec.items.join('\n');
    expect(rows).toContain(failGlyph);
    expect(rows).toContain('malformed');
    expect(process.exitCode).toBe(1);
  });

  it('emits clean (staged=0) when map.projects is null', async () => {
    // Kills the L63 `map.projects === null` mutation: a null projects object must
    // trigger the early-return path (staged=0 -> clean) instead of iterating.
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: null }) + '\n',
    );
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    expect(sec.items.join('\n')).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('emits clean (staged=0) when map.projects is an array', async () => {
    // Kills the L63 `typeof map.projects !== 'object'` half of the guard: an
    // array is an object in typeof, so only the Array.isArray-equivalent branch
    // catches it. Verifies that the guard rejects array-valued projects.
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, 'claude-nomad', 'path-map.json'),
      JSON.stringify({ projects: ['foo', 'bar'] }) + '\n',
    );
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    expect(sec.items.join('\n')).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('skips a project entry whose hosts value is null', async () => {
    // Kills the L69 `hosts === null` guard mutation: a null hosts object must
    // be skipped (staged=0) rather than attempting hosts[HOST] access.
    const env = makeEnv();
    testHome = env.testHome;
    writePathMap(testHome, { foo: null as unknown as Record<string, string> });
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    expect(sec.items.join('\n')).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('skips a project entry whose host path is TBD', async () => {
    // Kills the L71 `p === "TBD"` guard mutation: a TBD placeholder must be
    // skipped (staged=0) rather than treated as a real project path.
    const env = makeEnv();
    testHome = env.testHome;
    writePathMap(testHome, { foo: { 'test-host': 'TBD' } });
    mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    expect(sec.items.join('\n')).toContain(okGlyph);
    expect(process.exitCode).toBe(0);
  });

  it('passes staged count > 0 to scanAndReport when a mapped session dir exists', async () => {
    // Kills the L82 UpdateOperator mutation: `staged--` (decrement) instead of
    // `staged++` (increment) would pass staged=0 or negative to scanAndReport,
    // causing a falsely clean report instead of a scan. The test asserts that
    // scanAndReport receives a positive staged count.
    const env = makeEnv();
    testHome = env.testHome;
    writeFileSync(
      join(testHome, '.claude', 'projects', env.encodedDir, 'session1.jsonl'),
      '{"role":"user","text":"hello"}\n',
    );
    writePathMap(testHome, { foo: { 'test-host': env.localPath } });
    const getStaged = mockGitleaksAndCaptureScanArgs();
    const { reportCheckShared } = await import('./commands.doctor.check-shared.ts');
    const sec: Section = { header: 'Shared scan', items: [] };
    reportCheckShared(sec);
    // staged must be 1 (one session dir was staged); scanAndReport was called.
    expect(getStaged()).toBe(1);
  });
});
