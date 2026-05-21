import { mkdtempSync, rmSync } from 'node:fs';
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
});
