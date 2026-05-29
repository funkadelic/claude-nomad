import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

/**
 * Probe for a usable gitleaks binary once at suite-load time. Only the
 * `allowlist regression fixture` describe needs the real binary (it runs an
 * integration test against an actual gitleaks process); the mocked and pure
 * describes here work fine without it. We gate just the integration suite
 * via `describe.skipIf(!hasGitleaks)` so local dev without gitleaks can still
 * run the rest, while CI (which installs gitleaks via tests.yml) runs the
 * full file.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Mock-based execFileSync coverage for runGitleaksScan after its split
// out of push-checks.ts. The four cases here (clean scan, status-1 with
// stderr, status-1 with stdout-only, ENOENT install hint) previously
// lived in push-checks.test.ts under the same describe; they move
// verbatim with the dynamic import retargeted at ./push-gitleaks.ts.
// This file also extends to parser, FATAL builder, mixed-section,
// multi-session, and allowlist-regression coverage.
describe('runGitleaksScan (mocked child_process)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let stderrSpy: MockInstance<(...args: unknown[]) => boolean>;
  let stdoutSpy: MockInstance<(...args: unknown[]) => boolean>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-push-gitleaks-mock-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
    // Spy on process.stderr.write / process.stdout.write so the
    // stderr/stdout-forwarding branches in runGitleaksScan can be asserted
    // via call history.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    // The non-ENOENT re-throw test below adds a node:fs doMock; pair it here.
    // vi.restoreAllMocks does NOT clear vi.doMock module mocks, so an unpaired
    // mock would leak into later tests/files.
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('runGitleaksScan does not throw on clean scan', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).not.toThrow();
  });

  it('runGitleaksScan throws NomadFatal and suppresses raw stderr on detection (status 1)', async () => {
    // Synthesize the JSON report at the production-chosen path so the catch
    // block reaches the legacy detection FATAL via partitionFindings +
    // buildSessionAwareFatal (non-session path returns LEGACY_FATAL). Mirrors
    // how real gitleaks v8.x writes the report alongside the exit-1.
    // Under the new behavior, stderr must NOT be forwarded when the report
    // parses: the structured FATAL already describes the findings.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          // scanStagedTree runs `git init` + `git add -A` before gitleaks; let
          // those succeed so the gitleaks failure below is what drives the test.
          if (bin === 'git') return Buffer.from('');
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(
              reportPath,
              JSON.stringify([
                {
                  RuleID: 'generic-api-key',
                  File: 'src/foo.ts',
                  StartLine: 42,
                  Match: 'REDACTED',
                  Fingerprint: 'fp1',
                },
              ]),
            );
          }
          const err = new Error('Command failed') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('finding: redacted-secret in foo.ts');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks detected secrets/);
    expect(() => runGitleaksScan()).toThrow(/git diff --cached/);
    // Report parses to a findings array, so raw stderr must NOT be forwarded.
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0]);
    const leaked = calls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('redacted-secret')) ||
        (typeof chunk === 'string' && chunk.includes('redacted-secret')),
    );
    expect(leaked).toBe(false);
  });

  it('runGitleaksScan suppresses raw stdout on detection when the error carries only stdout', async () => {
    // Report parses to a findings array, so stdout must NOT be forwarded.
    // The structured FATAL fully describes the findings; the raw stream is
    // suppressed on the leaks-found path regardless of which stream is set.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          // Let scanStagedTree's `git init` + `git add -A` succeed so the
          // gitleaks failure below is the condition under test.
          if (bin === 'git') return Buffer.from('');
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(
              reportPath,
              JSON.stringify([
                {
                  RuleID: 'generic-api-key',
                  File: 'src/foo.ts',
                  StartLine: 42,
                  Match: 'REDACTED',
                  Fingerprint: 'fp1',
                },
              ]),
            );
          }
          const err = new Error('Command failed') as NodeJS.ErrnoException & {
            status?: number;
            stdout?: Buffer;
          };
          err.status = 1;
          err.stdout = Buffer.from('redacted-finding-on-stdout');
          // No err.stderr - this is the load-bearing distinguishing condition.
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks detected secrets/);
    // Report parsed to findings, so raw stdout must NOT have been forwarded.
    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]);
    const leaked = stdoutCalls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('redacted-finding-on-stdout')) ||
        (typeof chunk === 'string' && chunk.includes('redacted-finding-on-stdout')),
    );
    expect(leaked).toBe(false);
  });

  it('runGitleaksScan throws scan-failed FATAL when the JSON report is missing or unparseable', async () => {
    // gitleaks v8.x returns exit 1 for both "leaks found" and runtime errors.
    // When the report cannot be parsed (scanner crash, malformed JSON,
    // missing file), the catch must throw a distinct "scan failed" FATAL so
    // operators do not chase a phantom `nomad drop-session` recovery.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        // No --report-path file is written, so readGitleaksReport returns null.
        // scanStagedTree's `git init` + `git add -A` succeed; only gitleaks fails.
        execFileSync: vi.fn((bin: string) => {
          if (bin === 'git') return Buffer.from('');
          const err = new Error('config parse error') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('Error: invalid config at .gitleaks.toml');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks scan failed/);
    expect(() => runGitleaksScan()).toThrow(/no parseable JSON report/);
    expect(() => runGitleaksScan()).not.toThrow(/drop-session/);
  });

  it('runGitleaksScan throws scan-failed FATAL when the JSON report parses to a non-array shape', async () => {
    // readGitleaksReport returns null for both "JSON.parse throws" and
    // "JSON.parse succeeded but the result is not an array". This covers the
    // !Array.isArray branch by writing a valid JSON object (not array) to
    // the report path. The catch-path FATAL must still fire.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin === 'git') return Buffer.from('');
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            // Valid JSON, but an object (not the expected Finding[] array).
            writeFileSync(reportPath, '{"error": "scanner produced no findings list"}');
          }
          const err = new Error('non-array shape') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('error: malformed report');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks scan failed/);
    expect(() => runGitleaksScan()).toThrow(/no parseable JSON report/);
  });

  it('runGitleaksScan throws scan-failed FATAL when the JSON report exists but is malformed', async () => {
    // Distinct from the missing-report branch above: gitleaks wrote
    // something at --report-path but the bytes are not valid JSON (truncated
    // write, partial flush, etc.). readGitleaksReport's JSON.parse throws,
    // the inner catch returns null, and runGitleaksScan must still throw the
    // scan-failed FATAL rather than misclassify the failure as a detection.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin === 'git') return Buffer.from('');
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, '{this is not valid json');
          }
          const err = new Error('truncated') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('write error');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks scan failed/);
    expect(() => runGitleaksScan()).toThrow(/no parseable JSON report/);
  });

  it('forwards raw stderr on the scan-crash path (unparseable report)', async () => {
    // gitleaks throws with an err.stderr buffer AND writes no report file, so
    // readGitleaksReport returns null. On this crash path forwardStreams=true
    // must write the stderr buffer so "Review the gitleaks output above." has
    // something to point at. Covers the `report === null` forwarding branch.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin === 'git') return Buffer.from('');
          // No --report-path file written: readGitleaksReport returns null.
          const err = new Error('scanner crash') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('crash-stderr-diagnostic');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks scan failed/);
    // Null-report path: raw stderr must have been forwarded.
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0]);
    const forwarded = calls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('crash-stderr-diagnostic')) ||
        (typeof chunk === 'string' && chunk.includes('crash-stderr-diagnostic')),
    );
    expect(forwarded).toBe(true);
  });

  it('forwards raw stdout on the scan-crash path when only stdout is set (unparseable report)', async () => {
    // Crash path where only err.stdout is set (no err.stderr). The stdout
    // branch inside `if (forwardStreams && report === null)` must be exercised
    // so both inner stream writes have 100% patch coverage.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin === 'git') return Buffer.from('');
          // No report file written: readGitleaksReport returns null.
          const err = new Error('scanner crash stdout') as NodeJS.ErrnoException & {
            status?: number;
            stdout?: Buffer;
          };
          err.status = 1;
          err.stdout = Buffer.from('crash-stdout-diagnostic');
          // No err.stderr - load-bearing: covers the stdout inner write.
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks scan failed/);
    // Null-report path: raw stdout must have been forwarded.
    const calls = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]);
    const forwarded = calls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('crash-stdout-diagnostic')) ||
        (typeof chunk === 'string' && chunk.includes('crash-stdout-diagnostic')),
    );
    expect(forwarded).toBe(true);
  });

  it('runGitleaksScan throws NomadFatal with install hint on ENOENT (defense in depth)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          // scanStagedTree's `git init` + `git add -A` succeed; gitleaks is the
          // binary missing from PATH, so its ENOENT propagates to the
          // install-hint FATAL.
          if (bin === 'git') return Buffer.from('');
          const err = new Error('spawn gitleaks ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks not on PATH/);
    expect(() => runGitleaksScan()).toThrow(/Install:/);
  });

  it('re-throws a non-ENOENT scanStagedTree error verbatim instead of the install-hint FATAL', async () => {
    // The catch in runGitleaksScan only maps ENOENT to the install-hint FATAL;
    // any other error must propagate unchanged (`throw err`). scanStagedTree
    // swallows non-ENOENT execFileSync failures, so drive the error from its
    // pre-try `mkdirSync(cacheDir)`: a non-ENOENT (EACCES) failure there escapes
    // scanStagedTree directly, reaching runGitleaksScan's non-ENOENT branch.
    const cacheFailure = Object.assign(new Error('mkdir /cache: permission denied'), {
      code: 'EACCES',
    });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        mkdirSync: vi.fn((p: fsModule.PathLike, o?: fsModule.MakeDirectoryOptions) => {
          if (String(p).includes(join('.cache', 'claude-nomad'))) throw cacheFailure;
          return actual.mkdirSync(p, o);
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(cacheFailure);
    // The error is the raw EACCES, NOT wrapped in the install-hint NomadFatal.
    expect(() => runGitleaksScan()).not.toThrow(/gitleaks not on PATH/);
    expect(() => runGitleaksScan()).not.toThrow(/Install:/);
  });

  it('removes the temp gitleaks JSON report after a successful (no-findings) scan', async () => {
    // Capture the report path the production code chose via the --report-path
    // arg, write a synthetic empty findings array there (mirroring what
    // gitleaks does on a clean scan), then return success. After
    // runGitleaksScan returns, the finally-block rmSync must have removed
    // the file.
    let capturedReportPath = '';
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const argList = args ?? [];
          const flag = argList.find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            capturedReportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(capturedReportPath), { recursive: true });
            writeFileSync(capturedReportPath, '[]');
          }
          return Buffer.from('');
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).not.toThrow();
    expect(capturedReportPath).not.toBe('');
    expect(existsSync(capturedReportPath)).toBe(false);
  });

  it('removes the temp gitleaks JSON report after a failed (findings detected) scan', async () => {
    // The mock writes a synthetic non-empty findings array to the
    // --report-path before throwing. After runGitleaksScan throws, the
    // finally-block rmSync must have removed the file.
    let capturedReportPath = '';
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin === 'git') return Buffer.from('');
          const argList = args ?? [];
          const flag = argList.find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            capturedReportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(capturedReportPath), { recursive: true });
            const findings = [
              {
                RuleID: 'generic-api-key',
                File: 'shared/CLAUDE.md',
                StartLine: 1,
                Match: 'REDACTED',
                Fingerprint: 'fp1',
              },
            ];
            writeFileSync(capturedReportPath, JSON.stringify(findings));
          }
          const err = new Error('Command failed') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('finding');
          throw err;
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).toThrow(/gitleaks detected secrets/);
    expect(capturedReportPath).not.toBe('');
    expect(existsSync(capturedReportPath)).toBe(false);
  });
});

// Pure-function coverage for the gitleaks-output classifier and the
// session-aware FATAL message builder. The classifier (partitionFindings)
// groups findings by session id with per-RuleID counts; non-session paths
// fall through into `other`. The builder (buildSessionAwareFatal) renders
// the multi-section FATAL message. These are exported helpers consumed by
// runGitleaksScan in its non-ENOENT catch branch.
//
// Local-shim types mirror the expected signatures so the dynamic import
// destructures cleanly under @typescript-eslint/no-unsafe-*. They are not
// the contract; the production types in push-gitleaks.ts are.
type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  StartColumn: number;
  EndColumn: number;
  Match: string;
  Fingerprint: string;
};
type PartitionFindings = (findings: Finding[]) => {
  bySession: Map<string, Map<string, number>>;
  other: Finding[];
};
type BuildSessionAwareFatal = (
  bySession: Map<string, Map<string, number>>,
  other: Finding[],
) => string;
type FormatOtherFinding = (f: Finding) => string;
type PushGitleaksModule = {
  partitionFindings: PartitionFindings;
  buildSessionAwareFatal: BuildSessionAwareFatal;
  formatOtherFinding: FormatOtherFinding;
};

describe('partitionFindings (pure)', () => {
  it('groups findings by session id and counts per RuleID', async () => {
    const { partitionFindings } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 12,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 13,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
      {
        RuleID: 'aws-access-token',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 14,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp3',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/bar/sid-B.jsonl',
        StartLine: 9,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp4',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const shaped = Object.fromEntries(
      [...bySession.entries()].map(([k, v]) => [k, Object.fromEntries(v.entries())]),
    );
    expect(bySession.size).toBe(2);
    expect(shaped['sid-A']).toEqual({ 'generic-api-key': 2, 'aws-access-token': 1 });
    expect(shaped['sid-B']).toEqual({ 'generic-api-key': 1 });
    expect(other).toEqual([]);
  });

  it('puts non-session paths into the `other` bucket', async () => {
    const { partitionFindings } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/CLAUDE.md',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 2,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    expect(bySession.size).toBe(1);
    expect(other.length).toBe(1);
    expect(other[0]?.File).toBe('shared/CLAUDE.md');
  });

  it('ignores paths that look session-shaped but are not top-level JSONLs (subagents subdir)', async () => {
    const { partitionFindings } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/subagents/sid.jsonl',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    expect(bySession.size).toBe(0);
    expect(other.length).toBe(1);
  });
});

describe('buildSessionAwareFatal (pure)', () => {
  it('single-session message contains the id, the RuleID with count, the drop-session hint, and the trailer', async () => {
    const { partitionFindings, buildSessionAwareFatal } =
      (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 2,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const msg = buildSessionAwareFatal(bySession, other);
    expect(msg).toContain('sid-A');
    expect(msg).toContain('generic-api-key');
    expect(msg).toContain('(2)');
    expect(msg).toContain('nomad drop-session sid-A');
    expect(msg).toContain('After recovery, re-run nomad push.');
  });

  it('multi-session message emits one drop-session line per affected session', async () => {
    const { partitionFindings, buildSessionAwareFatal } =
      (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/bar/sid-B.jsonl',
        StartLine: 2,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const msg = buildSessionAwareFatal(bySession, other);
    expect(msg).toContain('nomad drop-session sid-A');
    expect(msg).toContain('nomad drop-session sid-B');
  });

  it('mixed session + non-session emits an `Also found:` block listing the non-session path', async () => {
    const { partitionFindings, buildSessionAwareFatal } =
      (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/CLAUDE.md',
        StartLine: 3,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const msg = buildSessionAwareFatal(bySession, other);
    expect(msg).toContain('Also found:');
    expect(msg).toContain('shared/CLAUDE.md:3');
    expect(msg).toContain('generic-api-key');
    expect(msg).toContain('Review with: git diff --cached, then unstage manually.');
  });

  it('formats an `Also found:` row with the File:StartLine locator for a positive line', async () => {
    const { formatOtherFinding } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const row = formatOtherFinding({
      RuleID: 'github-pat',
      File: 'shared/projects/foo/subagents/agent-x.jsonl',
      StartLine: 208,
      StartColumn: 1,
      EndColumn: 10,
      Match: 'REDACTED',
      Fingerprint: 'fp',
    });
    expect(row).toBe('  shared/projects/foo/subagents/agent-x.jsonl:208  github-pat');
  });

  it('drops the line suffix when StartLine is non-positive or absent', async () => {
    const { formatOtherFinding } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const base = {
      RuleID: 'github-pat',
      File: 'shared/CLAUDE.md',
      StartColumn: 1,
      EndColumn: 10,
      Match: 'REDACTED',
      Fingerprint: 'fp',
    };
    // StartLine 0 (non-positive integer) and an absent StartLine (a degraded
    // gitleaks report survives `parsed as Finding[]` without the field) both
    // render `<File>  <RuleID>` rather than a confusing `:0` / `:undefined`.
    expect(formatOtherFinding({ ...base, StartLine: 0 })).toBe('  shared/CLAUDE.md  github-pat');
    expect(formatOtherFinding({ ...base } as unknown as Finding)).toBe(
      '  shared/CLAUDE.md  github-pat',
    );
  });

  it('non-session-only findings return the exact legacy fallback string', async () => {
    const { partitionFindings, buildSessionAwareFatal } =
      (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/CLAUDE.md',
        StartLine: 1,
        StartColumn: 1,
        EndColumn: 10,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const msg = buildSessionAwareFatal(bySession, other);
    expect(msg).toBe(
      'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry',
    );
  });
});

// --config wiring: pass --config <REPO_HOME>/.gitleaks.toml when the file
// exists; omit silently when missing (graceful fallback for fresh clones
// or hosts that have not yet run `nomad update`). Captures the argv
// passed to mocked execFileSync so the wiring is observable without
// invoking real gitleaks.
describe('--config wiring (mocked child_process)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let capturedArgs: string[] = [];

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-push-gitleaks-config-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(repoUnderHome, { recursive: true });
    capturedArgs = [];
    vi.resetModules();
    // Silence the stderr/stdout-forwarding writes on the failure path so the
    // test output stays clean.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('passes --config <REPO_HOME>/.gitleaks.toml when the toml exists', async () => {
    // Pre-create the toml inside the temp REPO_HOME so existsSync returns
    // true at runGitleaksScan call time.
    writeFileSync(join(repoUnderHome, '.gitleaks.toml'), '[allowlist]\nregexes = []\n');
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          capturedArgs = [...(args ?? [])];
          // Simulate a clean scan so the function returns without throwing.
          const flag = capturedArgs.find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, '[]');
          }
          return Buffer.from('');
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).not.toThrow();
    expect(capturedArgs.includes('--config')).toBe(true);
    const idx = capturedArgs.indexOf('--config');
    const value = capturedArgs[idx + 1];
    expect(value).toBeDefined();
    expect(value?.endsWith('.gitleaks.toml')).toBe(true);
  });

  it('omits --config when the toml is missing (graceful skip)', async () => {
    // Do NOT create the toml. existsSync at the temp REPO_HOME returns false
    // → runGitleaksScan must invoke gitleaks WITHOUT the --config flag.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          capturedArgs = [...(args ?? [])];
          const flag = capturedArgs.find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, '[]');
          }
          return Buffer.from('');
        }),
      };
    });
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    expect(() => runGitleaksScan()).not.toThrow();
    expect(capturedArgs.includes('--config')).toBe(false);
  });
});

// Allowlist regression fixture: real-gitleaks integration test. Builds a
// temp git repo containing one synthetic file per allowlist pattern plus
// one real-looking ghp_<36> PAT, runs the real gitleaks binary (no mock)
// against it, and asserts only the PAT fires. The toml comes from the
// worktree's committed .gitleaks.toml (read at test setup time) so the
// test exercises the actual production allowlist. Future PRs that widen
// the allowlist to match real-secret formats would regress this test.
// Skips locally when gitleaks is not on PATH; CI installs gitleaks
// (tests.yml) so this suite always runs there.
describe.skipIf(!hasGitleaks)('allowlist regression fixture', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-push-gitleaks-allowlist-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    mkdirSync(repoUnderHome, { recursive: true });
    vi.resetModules();
    // Silence the stderr/stdout-forwarding noise from the failure path.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('suppresses the four allowlist patterns while still firing on a real ghp_<36> PAT', async () => {
    // Copy the worktree's .gitleaks.toml into the temp REPO_HOME so the real
    // gitleaks subprocess loads the production allowlist via --config.
    // The worktree root is one directory up from this test file:
    // <worktree>/src/push-gitleaks.test.ts → <worktree>/.gitleaks.toml.
    // ESM has no __dirname; derive it from import.meta.url instead.
    const here = dirname(fileURLToPath(import.meta.url));
    const worktreeToml = join(here, '..', '.gitleaks.toml');
    copyFileSync(worktreeToml, join(repoUnderHome, '.gitleaks.toml'));

    // Initialize a real git repo so `gitleaks protect --staged` has staged
    // content. Identity is required by some git versions even for `git add`.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoUnderHome });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repoUnderHome,
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoUnderHome });

    // Place the real PAT inside a session JSONL so the session-aware FATAL
    // surfaces the session id. The four allowlist-pattern files live at
    // unrelated top-level paths. Assemble the PAT at runtime from split
    // fragments so the contiguous token shape never appears in source-
    // controlled bytes (Betterleaks and other secret scanners flag committed
    // PAT-shaped literals even in test fixtures).
    const sessionDir = join(repoUnderHome, 'shared', 'projects', 'foo');
    mkdirSync(sessionDir, { recursive: true });
    const sid = 'sid-allowlist-regression';
    // Distinct from the documented test-fixture literal so the new
    // path-scoped allowlist (which suppresses the documented literal under
    // `shared/projects/.../*.jsonl`) does NOT swallow this fake. The
    // fragments avoid storing a contiguous PAT-shaped token in source.
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    writeFileSync(join(sessionDir, `${sid}.jsonl`), `{"role":"user","text":"${fakePat}"}\n`);

    // One staged file per allowlist pattern. Each MUST be suppressed.
    // Sonar issue key: AY + >=20 base64-like chars.
    writeFileSync(join(repoUnderHome, 'sonar.txt'), 'AYabcdefghijklmnopqrst_xyz\n');
    // gitleaks fingerprint format: <file-path-with-extension>:<rule-id>:<line>.
    // The path component MUST contain a file-extension token; arbitrary
    // colon-separated alphanumerics (e.g., user:password:port) are not
    // suppressed by the tightened allowlist regex.
    writeFileSync(join(repoUnderHome, 'gl-fingerprint.txt'), 'src/foo.ts:generic-api-key:42\n');
    // npm audit advisory hash anchored on JSON id field.
    writeFileSync(
      join(repoUnderHome, 'audit.json'),
      '{"id": "abcdef0123456789abcdef0123456789abcdef01"}\n',
    );
    // Coverage line-key: key=<hash> <path>:<line>.
    writeFileSync(join(repoUnderHome, 'coverage.txt'), 'key=deadbeef12 src/foo.ts:99\n');

    execFileSync('git', ['add', '-A'], { cwd: repoUnderHome });

    // Import runGitleaksScan AFTER process.env.HOME is set so REPO_HOME
    // resolves to repoUnderHome via os.homedir().
    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    let caught: Error | null = null;
    try {
      runGitleaksScan();
    } catch (err) {
      caught = err as Error;
    }
    // Real gitleaks must have fired on the PAT, throwing NomadFatal.
    expect(caught).not.toBeNull();
    const msg = caught?.message ?? '';

    // Session-aware FATAL surfaces: names the session id, references the
    // drop-session recovery command, and ends with the standard trailer.
    expect(msg).toContain(sid);
    expect(msg).toContain(`nomad drop-session ${sid}`);

    // The four allowlist patterns must NOT appear in the FATAL message,
    // they were suppressed inside the gitleaks process before reaching the
    // findings array. No `Also found:` section should be populated by them.
    expect(msg).not.toContain('sonar.txt');
    expect(msg).not.toContain('gl-fingerprint.txt');
    expect(msg).not.toContain('audit.json');
    expect(msg).not.toContain('coverage.txt');
  });

  it('does not allowlist a credential-shaped colon tuple co-located with a real PAT', async () => {
    // Regression for the prior broad allowlist regex `[\w-]+:[\w-]+:\d+`,
    // which matched arbitrary alphanumeric colon-tuples like
    // user:password:port. The tightened regex requires a file-extension
    // token in the path component, so credential-shaped strings no longer
    // suppress co-located real secrets. The session JSONL embeds both a
    // colon-tuple line (which the old regex would have allowlisted) and a
    // real PAT-shaped string. The PAT must still fire AND the
    // colon-tuple line must NOT trigger an allowlist suppression that
    // hides any other finding on the same line.
    const here = dirname(fileURLToPath(import.meta.url));
    const worktreeToml = join(here, '..', '.gitleaks.toml');
    copyFileSync(worktreeToml, join(repoUnderHome, '.gitleaks.toml'));

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoUnderHome });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repoUnderHome,
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoUnderHome });

    const sessionDir = join(repoUnderHome, 'shared', 'projects', 'foo');
    mkdirSync(sessionDir, { recursive: true });
    const sid = 'sid-credentialish-colon-tuple';
    // The two lines: a credential-shaped colon tuple (no file extension,
    // so the tightened allowlist must skip it) and a separate line with a
    // real GitHub PAT. The PAT must surface in the FATAL. Assemble the PAT
    // at runtime so the contiguous token shape is not committed verbatim.
    // Distinct body from the documented test-fixture literal so the new
    // path-scoped allowlist does not swallow this PAT.
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    writeFileSync(
      join(sessionDir, `${sid}.jsonl`),
      [
        '{"role":"user","text":"db: admin:SuperSecret123:8080"}',
        `{"role":"assistant","text":"token=${fakePat}"}`,
        '',
      ].join('\n'),
    );

    execFileSync('git', ['add', '-A'], { cwd: repoUnderHome });

    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    let caught: Error | null = null;
    try {
      runGitleaksScan();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    const msg = caught?.message ?? '';
    // Session-aware FATAL still names the session id and the
    // drop-session hint because the PAT fired.
    expect(msg).toContain(sid);
    expect(msg).toContain(`nomad drop-session ${sid}`);
  });

  it('allowlists the documented test-fixture github-pat literal inside shared/projects session paths', async () => {
    // The literal `ghp_<test-fixture-pat>` (see `.gitleaks.toml`
    // path-scoped `[[allowlists]]` block) accumulates in Claude Code
    // session transcripts whenever a conversation touches the
    // gitleaks Pitfall 4 docs or the allowlist config itself. Live
    // sessions cannot be safely sed-scrubbed (sed -i renames out from
    // under the open file descriptor), so the allowlist swallows the
    // documented literal under `shared/projects/<logical>/.../*.jsonl`
    // paths. A real PAT in the same file (different 36-char body)
    // still fires; see the earlier regression test above.
    const here = dirname(fileURLToPath(import.meta.url));
    const worktreeToml = join(here, '..', '.gitleaks.toml');
    copyFileSync(worktreeToml, join(repoUnderHome, '.gitleaks.toml'));

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoUnderHome });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repoUnderHome,
    });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoUnderHome });

    const sessionDir = join(repoUnderHome, 'shared', 'projects', 'foo');
    mkdirSync(join(sessionDir, 'sid-suppressed', 'subagents'), { recursive: true });
    // Assemble the documented test-fixture literal at runtime so the
    // contiguous token shape never sits in source-controlled bytes.
    const fixture = ['gh', 'p_', 'xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA'].join('');
    writeFileSync(
      join(sessionDir, 'sid-suppressed.jsonl'),
      `{"role":"user","text":"${fixture}"}\n`,
    );
    writeFileSync(
      join(sessionDir, 'sid-suppressed', 'subagents', 'agent-a1.jsonl'),
      `{"role":"assistant","text":"${fixture}"}\n`,
    );

    execFileSync('git', ['add', '-A'], { cwd: repoUnderHome });

    const { runGitleaksScan } = await import('./push-gitleaks.ts');
    // No throw expected: both top-level and subagent paths are
    // allowlisted by the new path-scoped block, and there is no other
    // staged content that would fire on a different rule.
    expect(() => runGitleaksScan()).not.toThrow();
  });
});
