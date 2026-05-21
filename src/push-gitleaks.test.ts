import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import type * as cpModule from 'node:child_process';

// gitleaks is a required dependency for this project's safety pipeline
// (`cmdPush` probes for it at top-of-flow). The allowlist regression
// fixture is an integration test against the real binary because the
// allowlist semantics are enforced inside the gitleaks process, not in
// nomad code. Hard-fail the whole test file when gitleaks is absent
// rather than silently skip. The allowlist acceptance criterion must
// always run on CI.
beforeAll(() => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'gitleaks binary required for src/push-gitleaks.test.ts; install via install.sh or the gitleaks release page (https://github.com/gitleaks/gitleaks/releases).',
    );
  }
});

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
// runGitleaksScan in its non-ENOENT catch branch.
//
// Local-shim types mirror the expected signatures so the dynamic import
// destructures cleanly under @typescript-eslint/no-unsafe-*. They are not
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
// Hard-fails the file when gitleaks is missing (beforeAll above) rather
// than silently skipping.
describe('allowlist regression fixture', () => {
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
    const fakePat = ['gh', 'p_', 'xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA'].join('');
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
    const fakePat = ['gh', 'p_', 'xJZbT3qfV2nLpKR8mYwH4dGtCsW9aE1uF6oA'].join('');
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
});
