import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as cpModule from 'node:child_process';
import type * as fsModule from 'node:fs';

/**
 * Mock-based coverage for `scanFile`'s error and stream-forwarding branches.
 * The integration tests in `commands.redact.test.ts` exercise the real-gitleaks
 * happy path; these cover the paths that need a synthesized failure: ENOENT,
 * the unparseable-report stream forwarding, and the `--config` toml branches.
 */
describe('scanFile (mocked child_process)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let stderrSpy: MockInstance<(...args: unknown[]) => boolean>;
  let stdoutSpy: MockInstance<(...args: unknown[]) => boolean>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scanfile-mock-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'repo');
    mkdirSync(process.env.NOMAD_REPO, { recursive: true });
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns [] on a clean scan and omits --config when neither toml exists', async () => {
    // Mock existsSync to always return false so neither REPO_HOME nor bundled
    // copy is found, ensuring --config is omitted and the scan still runs.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    let seenArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          seenArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toEqual([]);
    expect(seenArgs).not.toContain('--config');
  });

  it('passes --config <toml> when REPO_HOME/.gitleaks.toml exists', async () => {
    writeFileSync(join(process.env.NOMAD_REPO!, '.gitleaks.toml'), '# allowlist\n');
    let seenArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          seenArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toEqual([]);
    expect(seenArgs).toContain('--config');
    expect(seenArgs).toContain(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it('passes --config <bundled> when REPO_HOME toml absent but bundled exists', async () => {
    // Repo copy absent (existsSync first call false), bundled present (second true).
    // The cache dir mkdirSync still needs to work, so only intercept existsSync.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      };
    });
    let seenArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          seenArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toEqual([]);
    expect(seenArgs).toContain('--config');
    const configIdx = (seenArgs as string[]).indexOf('--config');
    const configPath = (seenArgs as string[])[configIdx + 1];
    expect(configPath).toMatch(/\.gitleaks\.toml$/);
    expect(configPath).not.toBe(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it('returns null when gitleaks is absent (ENOENT)', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('not found') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toBeNull();
  });

  it('does NOT forward streams when crashing with default forwardStreams (omitted arg)', async () => {
    // Kills the BooleanLiteral mutation on line 171: `forwardStreams = false` -> `true`.
    // If the default were true, a crash with no parseable report would write to process streams.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('crash') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
            stdout?: Buffer;
          };
          err.status = 2;
          err.stderr = Buffer.from('scanfile-default-no-forward-stderr');
          err.stdout = Buffer.from('scanfile-default-no-forward-stdout');
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    // Call without the second arg: the default must be false -> no stream write.
    expect(scanFile('/some/file.jsonl')).toBeNull();
    const stderrLeaked = stderrSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('scanfile-default-no-forward-stderr'),
    );
    const stdoutLeaked = stdoutSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('scanfile-default-no-forward-stdout'),
    );
    expect(stderrLeaked).toBe(false);
    expect(stdoutLeaked).toBe(false);
  });

  it('returns parsed findings on exit-1 and does NOT forward streams when the report parses', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(
              reportPath,
              JSON.stringify([
                {
                  RuleID: 'generic-api-key',
                  File: '/some/file.jsonl',
                  StartLine: 1,
                  StartColumn: 1,
                  EndColumn: 9,
                  Match: 'real-secret',
                  Fingerprint: 'fp1',
                },
              ]),
            );
          }
          const err = new Error('detected') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          err.stderr = Buffer.from('finding-diagnostic');
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    // forwardStreams=true but the report parses, so the `report === null`
    // guard is false and stderr must NOT be forwarded.
    const findings = scanFile('/some/file.jsonl', true);
    expect(findings).not.toBeNull();
    expect(findings!.length).toBe(1);
    const leaked = stderrSpy.mock.calls.some(
      (c: unknown[]) => Buffer.isBuffer(c[0]) && c[0].toString().includes('finding-diagnostic'),
    );
    expect(leaked).toBe(false);
  });

  it('forwards stderr on the crash path (no parseable report) when forwardStreams=true', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('crash') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 2;
          err.stderr = Buffer.from('crash-stderr-diagnostic');
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl', true)).toBeNull();
    const forwarded = stderrSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('crash-stderr-diagnostic'),
    );
    expect(forwarded).toBe(true);
  });

  it('forwards stdout on the crash path when only stdout is set', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('crash') as NodeJS.ErrnoException & {
            status?: number;
            stdout?: Buffer;
          };
          err.status = 2;
          err.stdout = Buffer.from('crash-stdout-diagnostic');
          // No err.stderr: load-bearing so the stderr inner write is skipped.
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl', true)).toBeNull();
    const forwarded = stdoutSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('crash-stdout-diagnostic'),
    );
    expect(forwarded).toBe(true);
  });
});

/**
 * Mock-based coverage for `scanStagedTree`'s resolveTomlPath wiring.
 * Exercises the `toml !== null` branch (--config passed) and the null branch
 * (--config omitted, scan still runs) introduced by the two-tier lookup.
 */
describe('scanStagedTree (mocked child_process, resolveTomlPath wiring)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scan-staged-mock-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'repo');
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('passes --config when resolveTomlPath returns a path (toml !== null branch)', async () => {
    // REPO_HOME toml exists -> resolveTomlPath returns it -> --config is added.
    mkdirSync(process.env.NOMAD_REPO!, { recursive: true });
    writeFileSync(join(process.env.NOMAD_REPO!, '.gitleaks.toml'), '# allowlist\n');
    let seenArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          seenArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    expect(seenArgs).toContain('--config');
    expect(seenArgs).toContain(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it('omits --config when resolveTomlPath returns null (neither toml exists)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    let seenArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          seenArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    expect(seenArgs).not.toContain('--config');
  });

  it('re-throws ENOENT from the catch block (git or gitleaks absent)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          const err = new Error('not found') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(() => scanStagedTree(testHome)).toThrow(/not found/);
  });

  it('returns parsed findings from the catch block on non-zero gitleaks exit', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag === undefined) {
            // git init / git add: succeed silently.
            return Buffer.from('');
          }
          // gitleaks protect call: write report and throw exit-1.
          const reportPath = flag.slice('--report-path='.length);
          mkdirSync(dirname(reportPath), { recursive: true });
          writeFileSync(
            reportPath,
            JSON.stringify([
              {
                RuleID: 'generic-api-key',
                File: 'shared/foo.ts',
                StartLine: 1,
                StartColumn: 1,
                EndColumn: 9,
                Match: 'secret',
                Fingerprint: 'fp1',
              },
            ]),
          );
          const err = new Error('detected') as NodeJS.ErrnoException & { status?: number };
          err.status = 1;
          throw err;
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    const result = scanStagedTree(testHome);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it('does NOT forward streams when crashing with default forwardStreams (omitted arg)', async () => {
    // Kills the BooleanLiteral mutation on line 99: `forwardStreams = false` -> `true`.
    // If the default were true, an unexpected crash (status 2, no report) would
    // leak gitleaks stderr to the terminal. The default must be false.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? []).some((a) => a.startsWith('--report-path='))) {
            const err = new Error('crash') as NodeJS.ErrnoException & {
              status?: number;
              stderr?: Buffer;
              stdout?: Buffer;
            };
            err.status = 2;
            err.stderr = Buffer.from('default-no-forward-stderr');
            err.stdout = Buffer.from('default-no-forward-stdout');
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    // Call without the second arg: default forwardStreams must be false.
    expect(scanStagedTree(testHome)).toBeNull();
    const stderrLeaked = stderrSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('default-no-forward-stderr'),
    );
    const stdoutLeaked = stdoutSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('default-no-forward-stdout'),
    );
    expect(stderrLeaked).toBe(false);
    expect(stdoutLeaked).toBe(false);
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('does NOT forward streams when forwardStreams=true but report IS parseable (no crash path)', async () => {
    // Kills L123 ConditionalExpression->true and LogicalOperator->|| mutations.
    // The || mutation: `forwardStreams && report === null` -> `forwardStreams || report === null`
    // means streams would leak even when the report IS parsed (a findings result).
    // This test asserts: forwardStreams=true + non-zero exit + parseable report -> no stream write.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          const flag = (args ?? []).find((a) => a.startsWith('--report-path='));
          if (flag !== undefined) {
            // Write a parseable findings report before throwing.
            const reportPath = flag.slice('--report-path='.length);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(
              reportPath,
              JSON.stringify([
                {
                  RuleID: 'generic-api-key',
                  File: 'shared/foo.ts',
                  StartLine: 1,
                  StartColumn: 1,
                  EndColumn: 9,
                  Match: 'secret',
                  Fingerprint: 'fp-staged',
                },
              ]),
            );
            const err = new Error('found') as NodeJS.ErrnoException & {
              status?: number;
              stderr?: Buffer;
            };
            err.status = 1;
            err.stderr = Buffer.from('staged-finding-stderr-must-not-appear');
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    // forwardStreams=true, but report parses -> streams must NOT be written.
    const result = scanStagedTree(testHome, true);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    const leaked = stderrSpy.mock.calls.some(
      (c: unknown[]) =>
        Buffer.isBuffer(c[0]) && c[0].toString().includes('staged-finding-stderr-must-not-appear'),
    );
    expect(leaked).toBe(false);
    stderrSpy.mockRestore();
  });

  it('forwards stderr on the staged-scan crash path when forwardStreams=true', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? []).some((a) => a.startsWith('--report-path='))) {
            const err = new Error('crash') as NodeJS.ErrnoException & {
              status?: number;
              stderr?: Buffer;
            };
            err.status = 2;
            err.stderr = Buffer.from('staged-crash-stderr');
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome, true)).toBeNull();
    const forwarded = stderrSpy.mock.calls.some(
      (c: unknown[]) => Buffer.isBuffer(c[0]) && c[0].toString().includes('staged-crash-stderr'),
    );
    expect(forwarded).toBe(true);
    stderrSpy.mockRestore();
  });

  it('forwards stdout on the staged-scan crash path when forwardStreams=true', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? []).some((a) => a.startsWith('--report-path='))) {
            const err = new Error('crash') as NodeJS.ErrnoException & {
              status?: number;
              stdout?: Buffer;
            };
            err.status = 2;
            err.stdout = Buffer.from('staged-crash-stdout');
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome, true)).toBeNull();
    const forwarded = stdoutSpy.mock.calls.some(
      (c: unknown[]) => Buffer.isBuffer(c[0]) && c[0].toString().includes('staged-crash-stdout'),
    );
    expect(forwarded).toBe(true);
    stdoutSpy.mockRestore();
  });
});

/**
 * Temp-config cleanup wiring: when an overlay exists, `resolveTomlConfig`
 * generates a temp config and `scanStagedTree` / `scanFile` MUST remove it via
 * `rmSync(tempPath, { force: true })` in their `finally`, on both the clean
 * (success) path and the gitleaks-non-zero (failure) path. The no-overlay path
 * (tempPath null) must NOT rmSync a temp config.
 */
describe('scan-site temp-config cleanup (resolveTomlConfig wiring)', () => {
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let repoHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scan-cleanup-'));
    process.env.HOME = testHome;
    repoHome = join(testHome, 'repo');
    process.env.NOMAD_REPO = repoHome;
    mkdirSync(repoHome, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Mock node:fs so an overlay exists (no full repo toml, bundled present), and
   * capture rmSync calls. existsSync: repo toml absent, overlay present, all else
   * present (bundled + cache dir checks). readFileSync used for the overlay body.
   */
  function mockFsWithOverlay(rmSyncSpy: ReturnType<typeof vi.fn>): void {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(repoHome, '.gitleaks.toml')) return false;
          if (s.endsWith('.gitleaks.overlay.toml')) return true;
          return true;
        }),
        readFileSync: vi.fn((p: unknown, enc?: unknown) => {
          if (String(p).endsWith('.gitleaks.overlay.toml')) {
            return '[[allowlists]]\nregexes = ["MY_TOKEN"]\n';
          }
          return actual.readFileSync(p as fsModule.PathOrFileDescriptor, enc as never);
        }),
        rmSync: rmSyncSpy.mockImplementation(actual.rmSync),
      };
    });
  }

  function mockExecOk(): void {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from('')),
      };
    });
  }

  function mockExecGitleaksFails(): void {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((_bin: string, args?: readonly string[]) => {
          if ((args ?? []).some((a) => a.startsWith('--report-path='))) {
            const err = new Error('crash') as NodeJS.ErrnoException & { status?: number };
            err.status = 2;
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
  }

  it('scanStagedTree removes the temp config on the success path', async () => {
    const rmSyncSpy = vi.fn();
    mockFsWithOverlay(rmSyncSpy);
    mockExecOk();
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('scanStagedTree removes the temp config on the failure path', async () => {
    const rmSyncSpy = vi.fn();
    mockFsWithOverlay(rmSyncSpy);
    mockExecGitleaksFails();
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    // gitleaks exits non-zero with no report -> null; temp must still be cleaned.
    expect(scanStagedTree(testHome)).toBeNull();
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('scanFile removes the temp config on the success path', async () => {
    const rmSyncSpy = vi.fn();
    mockFsWithOverlay(rmSyncSpy);
    mockExecOk();
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toEqual([]);
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('scanFile removes the temp config on the failure path', async () => {
    const rmSyncSpy = vi.fn();
    mockFsWithOverlay(rmSyncSpy);
    mockExecGitleaksFails();
    const { scanFile } = await import('./push-gitleaks.scan.ts');
    expect(scanFile('/some/file.jsonl')).toBeNull();
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('no-overlay path does NOT rmSync a temp config (tempPath null)', async () => {
    // No overlay file; only the report file is removed, never a nomad-gitleaks-cfg temp.
    const rmSyncSpy = vi.fn();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        rmSync: rmSyncSpy.mockImplementation(actual.rmSync),
      };
    });
    mockExecOk();
    const { scanStagedTree } = await import('./push-gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    const cleanedTemp = rmSyncSpy.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('nomad-gitleaks-cfg'),
    );
    expect(cleanedTemp).toBe(false);
  });
});
