import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  let target: string;
  let stderrSpy: MockInstance<(...args: unknown[]) => boolean>;
  let stdoutSpy: MockInstance<(...args: unknown[]) => boolean>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scanfile-mock-'));
    process.env.HOME = testHome;
    process.env.NOMAD_REPO = join(testHome, 'repo');
    mkdirSync(process.env.NOMAD_REPO, { recursive: true });
    target = join(testHome, 'file.jsonl');
    writeFileSync(target, '{"text":"hello"}\n');
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
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toEqual([]);
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toEqual([]);
    expect(seenArgs).toContain('--config');
    expect(seenArgs).toContain(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it('passes --config <bundled> when REPO_HOME toml absent but bundled exists', async () => {
    // Repo copy absent, and the overlay absent too so this exercises the
    // no-overlay fast path it is named for rather than the generation-failure
    // fallback. Everything else (packageRoot's package.json walk, then the
    // bundled toml itself) present. The cache dir mkdirSync still needs to
    // work, so only intercept existsSync.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return {
        ...actual,
        existsSync: vi.fn((p: unknown) => {
          const s = String(p);
          if (s === join(process.env.NOMAD_REPO!, '.gitleaks.toml')) return false;
          if (s.endsWith('.gitleaks.overlay.toml')) return false;
          return true;
        }),
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toEqual([]);
    expect(seenArgs).toContain('--config');
    const configIdx = (seenArgs as string[]).indexOf('--config');
    const configPath = (seenArgs as string[])[configIdx + 1];
    expect(configPath).toMatch(/\.gitleaks\.toml$/);
    expect(configPath).not.toBe(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it.each([
    ['projects/-enc/s.jsonl', 'shared/projects/-enc/s.jsonl'],
    ['skills/demo/a.md', 'shared/skills/demo/a.md'],
    ['../elsewhere/.gitattributes', 'scan/file.txt'],
  ])('stages %s at %s and scans it with protect --staged', async (local, staged) => {
    const src = join(testHome, '.claude', local);
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, 'hello\n');
    let stagedExists = false;
    let gitleaksArgs: readonly string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[], opts?: { cwd?: string }) => {
          if (bin === 'git' && (args ?? []).includes('add')) {
            stagedExists = existsSync(join(opts!.cwd!, staged));
          }
          if (bin === 'gitleaks') gitleaksArgs = args ?? [];
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(src)).toEqual([]);
    expect(stagedExists).toBe(true);
    expect(gitleaksArgs).toContain('protect');
    expect(gitleaksArgs).toContain('--staged');
    expect(gitleaksArgs).not.toContain('--redact');
  });

  it('stages at the caller-supplied stagedRel instead of deriving one', async () => {
    const staged = join('shared', 'projects', 'myproj', 's.jsonl');
    let stagedExists = false;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[], opts?: { cwd?: string }) => {
          if (bin === 'git' && (args ?? []).includes('add')) {
            stagedExists = existsSync(join(opts!.cwd!, staged));
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target, { stagedRel: staged })).toEqual([]);
    expect(stagedExists).toBe(true);
  });

  it('returns null without running anything when stagedRel escapes the scratch repo', async () => {
    const exec = vi.fn(() => Buffer.from(''));
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return { ...actual, execFileSync: exec };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target, { stagedRel: join('..', 'escape.txt') })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(join(testHome, '.cache', 'claude-nomad', 'escape.txt'))).toBe(false);
  });

  it('returns null and never runs gitleaks when git staged nothing', async () => {
    const bins: string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          bins.push(bin);
          if ((args ?? []).includes('ls-files')) {
            throw Object.assign(new Error('did not match any file(s) known to git'), { status: 1 });
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toBeNull();
    expect(bins).not.toContain('gitleaks');
  });

  it('isolates the scratch repo from inherited git env, hooks, fsmonitor and attributes', async () => {
    const saved = {
      obj: process.env.GIT_OBJECT_DIRECTORY,
      alt: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    };
    process.env.GIT_OBJECT_DIRECTORY = join(testHome, 'foreign-objects');
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(testHome, 'foreign-alt');
    const calls: {
      bin: string;
      args: readonly string[];
      opts: { env?: NodeJS.ProcessEnv; timeout?: number };
    }[] = [];
    let attributes = '';
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (
            bin: string,
            args: readonly string[],
            opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
          ) => {
            calls.push({ bin, args, opts });
            if (args.includes('add')) {
              attributes = readFileSync(join(opts.cwd, '.git', 'info', 'attributes'), 'utf8');
            }
            return Buffer.from('');
          },
        ),
      };
    });
    try {
      const { scanFile } = await import('./gitleaks.scan.ts');
      expect(scanFile(target, { timeoutMs: 4_000 })).toEqual([]);
    } finally {
      if (saved.obj === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = saved.obj;
      if (saved.alt === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = saved.alt;
    }
    expect(calls.map((c) => c.bin)).toEqual(['git', 'git', 'git', 'gitleaks']);
    for (const { bin, opts } of calls) {
      const gitVars = Object.keys(opts.env ?? {}).filter((k) => k.toUpperCase().startsWith('GIT_'));
      // gitleaks gets only the color override; nothing inherited survives.
      const allowed =
        bin === 'gitleaks' ? ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] : [];
      expect(gitVars).toEqual(allowed);
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(4_000);
    }
    expect(calls.at(-1)!.opts.env?.GIT_CONFIG_VALUE_0).toBe('never');
    const add = calls.find((c) => c.args.includes('add'))!.args;
    expect(add).toEqual(expect.arrayContaining(['core.autocrlf=false', 'core.fsmonitor=false']));
    expect(add.some((a) => a.startsWith('core.hooksPath='))).toBe(true);
    expect(attributes).toBe('* -text -filter -ident -working-tree-encoding diff\n');
  });

  it.each(['git', 'gitleaks'])('returns null when %s is absent (ENOENT)', async (missing) => {
    const bins: string[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          bins.push(bin);
          if (bin !== missing) return Buffer.from('');
          const err = new Error('not found') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toBeNull();
    // The missing binary was actually reached, after every git step when it is gitleaks.
    expect(bins.at(-1)).toBe(missing);
    if (missing === 'gitleaks') expect(bins).toEqual(['git', 'git', 'git', 'gitleaks']);
  });

  it('does NOT forward streams when crashing with default forwardStreams (omitted arg)', async () => {
    // Kills the BooleanLiteral mutation on line 171: `forwardStreams = false` -> `true`.
    // If the default were true, a crash with no parseable report would write to process streams.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin !== 'gitleaks') return Buffer.from('');
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    // Call without the second arg: the default must be false -> no stream write.
    expect(scanFile(target)).toBeNull();
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

  it('fails the whole report when one entry is unusable, rather than dropping it', async () => {
    // Silently discarding a malformed entry would mean pushing whatever
    // secret it described. Refusing the report makes the caller abort.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin !== 'gitleaks') return Buffer.from('');
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
                { StartLine: 2 },
              ]),
            );
          }
          const err = new Error('detected') as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer;
          };
          err.status = 1;
          throw err;
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toBeNull();
  });

  it('returns parsed findings on exit-1 and does NOT forward streams when the report parses', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
          if (bin !== 'gitleaks') return Buffer.from('');
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    // forwardStreams=true but the report parses, so the `report === null`
    // guard is false and stderr must NOT be forwarded.
    const findings = scanFile(target, { forwardStreams: true });
    expect(findings).not.toBeNull();
    expect(findings!).toHaveLength(1);
    const leaked = stderrSpy.mock.calls.some(
      (c: unknown[]) => Buffer.isBuffer(c[0]) && c[0].toString().includes('finding-diagnostic'),
    );
    expect(leaked).toBe(false);
  });

  it.each([
    ['gitleaks', 'gitleaks'],
    ['git add', 'add'],
  ])(
    'forwards stderr when %s crashes (no parseable report) with forwardStreams',
    async (_l, failing) => {
      const bins: string[] = [];
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof cpModule>();
        return {
          ...actual,
          execFileSync: vi.fn((bin: string, args?: readonly string[]) => {
            bins.push(bin);
            if (bin !== failing && !(args ?? []).includes(failing)) return Buffer.from('');
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
      const { scanFile } = await import('./gitleaks.scan.ts');
      expect(scanFile(target, { forwardStreams: true })).toBeNull();
      const forwarded = stderrSpy.mock.calls.some(
        (c: unknown[]) =>
          Buffer.isBuffer(c[0]) && c[0].toString().includes('crash-stderr-diagnostic'),
      );
      expect(forwarded).toBe(true);
      expect(stderrSpy).toHaveBeenCalledWith('scan aborted: crash\n');
      expect(bins.includes('gitleaks')).toBe(failing === 'gitleaks');
    },
  );

  it('names the killing signal in the cause line on the crash path', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin !== 'gitleaks') return Buffer.from('');
          throw Object.assign(new Error('spawnSync gitleaks ENOBUFS\nextra'), {
            code: 'ENOBUFS',
            signal: 'SIGTERM',
          });
        }),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target, { forwardStreams: true })).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith('scan aborted: spawnSync gitleaks ENOBUFS (SIGTERM)\n');
  });

  it('passes GITLEAKS_SCAN_TIMEOUT_MS as timeout on the gitleaks execFileSync call', async () => {
    let capturedOpts: { timeout?: number } | undefined;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (_bin: string, _args?: readonly string[], opts?: { timeout?: number }) => {
            capturedOpts = opts;
            return Buffer.from('');
          },
        ),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    const { GITLEAKS_SCAN_TIMEOUT_MS } = await import('../../core/config.ts');
    scanFile(target);
    expect(capturedOpts?.timeout).toBe(GITLEAKS_SCAN_TIMEOUT_MS);
  });

  it('passes an explicit timeoutMs into the gitleaks execFileSync options', async () => {
    let capturedOpts: { timeout?: number } | undefined;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (_bin: string, _args?: readonly string[], opts?: { timeout?: number }) => {
            capturedOpts = opts;
            return Buffer.from('');
          },
        ),
      };
    });
    const { scanFile } = await import('./gitleaks.scan.ts');
    scanFile(target, { timeoutMs: 3_000 });
    expect(capturedOpts?.timeout).toBeGreaterThan(0);
    expect(capturedOpts?.timeout).toBeLessThanOrEqual(3_000);
  });

  it('shares one deadline across the git calls and gitleaks', async () => {
    const timeouts: (number | undefined)[] = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (_bin: string, _args?: readonly string[], opts?: { timeout?: number }) => {
            timeouts.push(opts?.timeout);
            return Buffer.from('');
          },
        ),
      };
    });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000));
    const { scanFile } = await import('./gitleaks.scan.ts');
    scanFile(target, { timeoutMs: 4_000 });
    expect(timeouts).toEqual([3_000, 2_000, 1_000, 1]);
  });

  it('forwards stdout on the crash path when only stdout is set', async () => {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin !== 'gitleaks') return Buffer.from('');
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target, { forwardStreams: true })).toBeNull();
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    expect(seenArgs).toContain('--config');
    expect(seenArgs).toContain(join(process.env.NOMAD_REPO!, '.gitleaks.toml'));
  });

  it('omits --config when resolveTomlPath returns null (neither toml exists)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    expect(seenArgs).not.toContain('--config');
  });

  it('re-throws ENOENT from the catch block (git or gitleaks absent)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    expect(() => scanStagedTree(testHome)).toThrow(/not found/);
  });

  it('returns parsed findings from the catch block on non-zero gitleaks exit', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    const result = scanStagedTree(testHome);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
  });

  it('passes GITLEAKS_SCAN_TIMEOUT_MS on the gitleaks call but not on git init/add calls', async () => {
    const capturedCalls: { bin: string; timeout?: number }[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn(
          (bin: string, _args?: readonly string[], opts?: { timeout?: number }) => {
            capturedCalls.push({ bin, timeout: opts?.timeout });
            return Buffer.from('');
          },
        ),
      };
    });
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    const { GITLEAKS_SCAN_TIMEOUT_MS } = await import('../../core/config.ts');
    scanStagedTree(testHome);
    const gitCalls = capturedCalls.filter((c) => c.bin === 'git');
    const gitleaksCalls = capturedCalls.filter((c) => c.bin === 'gitleaks');
    expect(gitleaksCalls).toHaveLength(1);
    expect(gitleaksCalls[0].timeout).toBe(GITLEAKS_SCAN_TIMEOUT_MS);
    for (const call of gitCalls) {
      expect(call.timeout).toBeUndefined();
    }
  });

  it('returns null on a gitleaks timeout (hard scan failure, not a soft skip)', async () => {
    // A timeout makes execFileSync throw ETIMEDOUT and leaves no parseable
    // report, so the scan must report failure (null) the same as any other
    // gitleaks execution error, never a clean (empty-findings) result.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string) => {
          if (bin === 'gitleaks') {
            const err = new Error('spawn gitleaks ETIMEDOUT') as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: string;
            };
            err.code = 'ETIMEDOUT';
            err.killed = true;
            err.signal = 'SIGTERM';
            throw err;
          }
          return Buffer.from('');
        }),
      };
    });
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toBeNull();
  });

  it('does NOT forward streams when crashing with default forwardStreams (omitted arg)', async () => {
    // Kills the BooleanLiteral mutation on line 99: `forwardStreams = false` -> `true`.
    // If the default were true, an unexpected crash (status 2, no report) would
    // leak gitleaks stderr to the terminal. The default must be false.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>();
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
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
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    // forwardStreams=true, but report parses -> streams must NOT be written.
    const result = scanStagedTree(testHome, true);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
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
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
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
      return { ...actual, existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')) };
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
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
  let target: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scan-cleanup-'));
    process.env.HOME = testHome;
    repoHome = join(testHome, 'repo');
    process.env.NOMAD_REPO = repoHome;
    mkdirSync(repoHome, { recursive: true });
    target = join(testHome, 'file.jsonl');
    writeFileSync(target, '{"text":"hello"}\n');
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
            return '[[allowlists]]\nregexes = ["MY_TOKEN"]\npaths = ["x.txt"]\ncondition = "AND"\n';
          }
          // existsSync reports every path present, so the bundled path may not be real.
          if (String(p).endsWith('.gitleaks.toml')) return '';
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
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
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
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
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toEqual([]);
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('scanFile removes the temp config on the failure path', async () => {
    const rmSyncSpy = vi.fn();
    mockFsWithOverlay(rmSyncSpy);
    mockExecGitleaksFails();
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toBeNull();
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('nomad-gitleaks-cfg'), {
      recursive: true,
      force: true,
    });
  });

  it('scanFile cleans the temp config when the scratch-dir mkdtempSync throws', async () => {
    // resolveTomlConfig generates the overlay temp (nomad-gitleaks-cfg-), then the
    // scratch report-dir mkdtempSync (gitleaks-file-) fails. The finally must still
    // rmSync the temp config so it is not orphaned, and scanFile returns null.
    const rmSyncSpy = vi.fn();
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
            return '[[allowlists]]\nregexes = ["MY_TOKEN"]\npaths = ["x.txt"]\ncondition = "AND"\n';
          }
          if (String(p).endsWith('.gitleaks.toml')) return '';
          return actual.readFileSync(p as fsModule.PathOrFileDescriptor, enc as never);
        }),
        mkdtempSync: vi.fn((p: unknown) => {
          if (String(p).includes('gitleaks-file-')) throw new Error('scratch mkdtemp boom');
          return actual.mkdtempSync(p as string);
        }),
        rmSync: rmSyncSpy.mockImplementation(actual.rmSync),
      };
    });
    mockExecOk();
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)).toBeNull();
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
        existsSync: vi.fn((p: unknown) => String(p).endsWith('package.json')),
        rmSync: rmSyncSpy.mockImplementation(actual.rmSync),
      };
    });
    mockExecOk();
    const { scanStagedTree } = await import('./gitleaks.scan.ts');
    expect(scanStagedTree(testHome)).toEqual([]);
    const cleanedTemp = rmSyncSpy.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('nomad-gitleaks-cfg'),
    );
    expect(cleanedTemp).toBe(false);
  });
});

/**
 * Real-fs cleanup for `scanFile`: the scratch dir holds the unredacted report,
 * the file copy and the git objects, so nothing may survive any exit path.
 * Real git runs; only the failing step and gitleaks are faked.
 */
describe('scanFile scratch-dir cleanup (real fs, real git)', () => {
  let originalHome: string | undefined;
  let originalProfile: string | undefined;
  let originalNomadRepo: string | undefined;
  let testHome: string;
  let target: string;
  let cwds: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    originalNomadRepo = process.env.NOMAD_REPO;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-scanfile-cleanup-'));
    process.env.HOME = testHome;
    // os.homedir() reads USERPROFILE on Windows, not HOME.
    process.env.USERPROFILE = testHome;
    process.env.NOMAD_REPO = join(testHome, 'repo');
    mkdirSync(process.env.NOMAD_REPO, { recursive: true });
    target = join(testHome, 'file.jsonl');
    writeFileSync(target, '{"text":"hello"}\n');
    cwds = [];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalProfile !== undefined) process.env.USERPROFILE = originalProfile;
    else delete process.env.USERPROFILE;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    rmSync(testHome, { recursive: true, force: true });
  });

  /**
   * Run real git, but throw on `failOn` (a git subcommand). gitleaks exits 0, or
   * writes a one-finding report and exits 1 when `findings` is set.
   */
  function mockExec(failOn: string | undefined, findings: boolean): void {
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof cpModule>();
      return {
        ...actual,
        execFileSync: vi.fn((bin: string, args: string[], opts: cpModule.ExecFileSyncOptions) => {
          cwds.push(String(opts.cwd));
          if (failOn !== undefined && args.includes(failOn)) {
            throw Object.assign(new Error('boom'), { status: 128 });
          }
          if (bin === 'git') return actual.execFileSync(bin, args, opts);
          if (!findings) return Buffer.from('');
          const flag = args.find((a) => a.startsWith('--report-path='))!;
          const report = [
            {
              RuleID: 'r',
              File: 'f',
              StartLine: 1,
              StartColumn: 1,
              EndColumn: 2,
              Match: 'm',
              Fingerprint: 'fp',
            },
          ];
          writeFileSync(flag.slice('--report-path='.length), JSON.stringify(report));
          throw Object.assign(new Error('leaks'), { status: 1 });
        }),
      };
    });
  }

  /** Assert the cache dir is empty and every dir git or gitleaks ran in is gone. */
  function expectNoScratchLeft(): void {
    expect(readdirSync(join(testHome, '.cache', 'claude-nomad'))).toEqual([]);
    for (const cwd of cwds) expect(existsSync(cwd)).toBe(false);
  }

  it.each([
    ['a clean scan', undefined, false, 0],
    ['findings', undefined, true, 1],
    ['a git init throw', 'init', false, null],
    ['a git add throw', 'add', false, null],
  ])('removes the scratch dir after %s', async (_l, failOn, findings, expected) => {
    mockExec(failOn, findings);
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(target)?.length ?? null).toBe(expected);
    expect(cwds.length).toBeGreaterThan(0);
    expectNoScratchLeft();
  });

  it('removes the scratch dir when the file copy throws', async () => {
    mockExec(undefined, false);
    const { scanFile } = await import('./gitleaks.scan.ts');
    expect(scanFile(join(testHome, 'missing.jsonl'))).toBeNull();
    expect(cwds).toEqual([]);
    expectNoScratchLeft();
  });
});
