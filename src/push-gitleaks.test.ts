import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as cpModule from 'node:child_process';

// Mock-based execFileSync coverage for runGitleaksScan after its Phase 5
// D-04 split out of push-checks.ts. The four cases here (clean scan,
// status-1 with stderr, status-1 with stdout-only, ENOENT install hint)
// previously lived in push-checks.test.ts under the same describe; they
// move verbatim with the dynamic import retargeted at ./push-gitleaks.ts.
// The Wave 2 plan extends this file with parser, FATAL builder,
// mixed-section, multi-session, and regression-fixture tests.
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

  it('runGitleaksScan throws NomadFatal and forwards stderr on detection (status 1)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
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
    // stderrSpy should have received the forwarded buffer at least once.
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0]);
    const matched = calls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('redacted-secret')) ||
        (typeof chunk === 'string' && chunk.includes('redacted-secret')),
    );
    expect(matched).toBe(true);
  });

  it('runGitleaksScan forwards stdout (not stderr) and throws NomadFatal when the error carries only stdout', async () => {
    // Cover the stdout-truthy branch AND the stderr-falsey branch together:
    // gitleaks fails with a stdout payload only (no stderr). The forwarding
    // code emits the stdout to process.stdout.write and the FATAL still
    // fires.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
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
    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]);
    const matched = stdoutCalls.some(
      (chunk: unknown) =>
        (Buffer.isBuffer(chunk) && chunk.toString().includes('redacted-finding-on-stdout')) ||
        (typeof chunk === 'string' && chunk.includes('redacted-finding-on-stdout')),
    );
    expect(matched).toBe(true);
  });

  it('runGitleaksScan throws NomadFatal with install hint on ENOENT (defense in depth)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
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
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
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
// runGitleaksScan in its non-ENOENT catch branch (Phase 5 Wave 2 work).
//
// Local-shim types mirror the expected signatures so the dynamic import
// destructures cleanly under @typescript-eslint/no-unsafe-* during the
// RED phase (when the production exports do not yet exist). They are not
// the contract; the production types in push-gitleaks.ts are.
type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
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
type PushGitleaksModule = {
  partitionFindings: PartitionFindings;
  buildSessionAwareFatal: BuildSessionAwareFatal;
};

describe('partitionFindings (pure)', () => {
  it('groups findings by session id and counts per RuleID', async () => {
    const { partitionFindings } = (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 12,
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 13,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
      {
        RuleID: 'aws-access-token',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 14,
        Match: 'REDACTED',
        Fingerprint: 'fp3',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/bar/sid-B.jsonl',
        StartLine: 9,
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
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 2,
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
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/foo/sid-A.jsonl',
        StartLine: 2,
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
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/projects/bar/sid-B.jsonl',
        StartLine: 2,
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
        Match: 'REDACTED',
        Fingerprint: 'fp1',
      },
      {
        RuleID: 'generic-api-key',
        File: 'shared/CLAUDE.md',
        StartLine: 3,
        Match: 'REDACTED',
        Fingerprint: 'fp2',
      },
    ];
    const { bySession, other } = partitionFindings(findings);
    const msg = buildSessionAwareFatal(bySession, other);
    expect(msg).toContain('Also found:');
    expect(msg).toContain('shared/CLAUDE.md');
    expect(msg).toContain('generic-api-key');
    expect(msg).toContain('Review with: git diff --cached, then unstage manually.');
  });

  it('non-session-only findings return the exact legacy fallback string', async () => {
    const { partitionFindings, buildSessionAwareFatal } =
      (await import('./push-gitleaks.ts')) as PushGitleaksModule;
    const findings: Finding[] = [
      {
        RuleID: 'generic-api-key',
        File: 'shared/CLAUDE.md',
        StartLine: 1,
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
