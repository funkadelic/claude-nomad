import * as fs from 'node:fs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock only mkdtempSync (delegating to the real impl by default) so a single
// test can force scratch-dir creation to fail; every other fs call stays real.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof fs>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});

import { CRASH_SCAN_TIMEOUT_MS, redactWithGitleaks } from './crash-report.redact.ts';
import type { Finding } from './push-gitleaks.scan.ts';

/** A real-shaped mkdtempSync-created directory captured by the fake scan, so tests can assert cleanup. */
let capturedScratchDir: string | undefined;

/** Build a fake `scanFile`-shaped function that records the temp path it was called with. */
function fakeScan(
  result: Finding[] | null,
): (path: string, forward?: boolean, timeout?: number) => Finding[] | null {
  return (path, _forward, _timeout) => {
    capturedScratchDir = path;
    return result;
  };
}

describe('redactWithGitleaks', () => {
  afterEach(() => {
    capturedScratchDir = undefined;
  });

  it('applies applyRedactions when the scan returns findings', () => {
    const finding: Finding = {
      RuleID: 'generic-api-key',
      File: 'crash.txt',
      StartLine: 1,
      StartColumn: 1,
      EndColumn: 9,
      Match: 'sekret123',
      Fingerprint: 'fp1',
    };
    const text = 'error context contains sekret123 inline';
    const out = redactWithGitleaks(text, fakeScan([finding]));
    expect(out).toBe('error context contains [REDACTED:generic-api-key] inline');
  });

  it('returns the text unchanged when the scan returns an empty findings array', () => {
    const text = 'nothing secret here';
    const out = redactWithGitleaks(text, fakeScan([]));
    expect(out).toBe(text);
  });

  it('appends a single advisory line and never throws when the scan returns null', () => {
    const text = 'unscanned text';
    const out = redactWithGitleaks(text, fakeScan(null));
    expect(out).toContain(text);
    expect(out).toContain('gitleaks value-based scan unavailable');
    expect(out).toContain('Review before sharing this file publicly');
  });

  it('writes the text to a 0o600 scratch file before scanning', () => {
    const text = 'scratch-file-content';
    // Capture the file mode and parent dir DURING the scan, before the finally
    // block removes the scratch directory. NTFS ignores POSIX mode bits, so the
    // 0o600 assertion only holds off win32.
    let modeDuringScan: number | undefined;
    let parentDuringScan: string | undefined;
    const scan = (path: string): Finding[] | null => {
      modeDuringScan = statSync(path).mode & 0o777;
      parentDuringScan = dirname(path);
      return [];
    };
    redactWithGitleaks(text, scan);
    expect(capturedScratchDir).toBeUndefined(); // this test injects its own scan
    expect(parentDuringScan).toBeDefined();
    if (process.platform !== 'win32') {
      expect(modeDuringScan).toBe(0o600);
    }
    // The scratch dir is removed synchronously once redactWithGitleaks returns.
    expect(existsSync(parentDuringScan!)).toBe(false);
  });

  it('passes CRASH_SCAN_TIMEOUT_MS to the scan function', () => {
    let seenTimeout: number | undefined;
    const scan = (_path: string, _forward?: boolean, timeout?: number): Finding[] | null => {
      seenTimeout = timeout;
      return [];
    };
    redactWithGitleaks('anything', scan);
    expect(seenTimeout).toBe(CRASH_SCAN_TIMEOUT_MS);
  });

  it('removes the scratch directory in a finally on the success path', () => {
    let dirDuringScan: string | undefined;
    const scan = (path: string): Finding[] | null => {
      dirDuringScan = path;
      // The scratch dir must exist while the scan runs.
      expect(existsSync(path)).toBe(true);
      return [];
    };
    redactWithGitleaks('cleanup-success', scan);
    expect(dirDuringScan).toBeDefined();
    expect(existsSync(dirDuringScan!)).toBe(false);
  });

  it('removes the scratch directory in a finally even when scan returns null', () => {
    let dirDuringScan: string | undefined;
    const scan = (path: string): Finding[] | null => {
      dirDuringScan = path;
      expect(existsSync(path)).toBe(true);
      return null;
    };
    redactWithGitleaks('cleanup-null-path', scan);
    expect(existsSync(dirDuringScan!)).toBe(false);
  });

  it('degrades to the advisory when mkdtempSync itself fails (no scratch dir to clean)', () => {
    // Force the scratch-dir creation to fail: `dir` stays undefined, so the
    // catch returns the advisory and the finally skips the rmSync guard.
    vi.mocked(fs.mkdtempSync).mockImplementationOnce(() => {
      throw new Error('tmp unwritable');
    });
    const text = 'mkdtemp-fail';
    const out = redactWithGitleaks(text, fakeScan([]));
    expect(out).toContain(text);
    expect(out).toContain('gitleaks value-based scan unavailable');
  });

  it('degrades to the advisory (never throws) when scan throws, and still cleans up', () => {
    let dirDuringScan: string | undefined;
    const scan = (path: string): Finding[] | null => {
      dirDuringScan = path;
      throw new Error('scan blew up');
    };
    const text = 'will-throw';
    const out = redactWithGitleaks(text, scan);
    expect(out).toContain(text);
    expect(out).toContain('gitleaks value-based scan unavailable');
    expect(dirDuringScan).toBeDefined();
    expect(existsSync(dirDuringScan!)).toBe(false);
  });

  it('uses the real scanFile as the default when no scan is injected', () => {
    // Smoke-test the default parameter wiring without requiring gitleaks to
    // be installed: whatever scanFile returns (Finding[] or null), the
    // function must not throw and must return a string.
    const out = redactWithGitleaks('default-param-smoke-test');
    expect(typeof out).toBe('string');
  });
});

describe('redactWithGitleaks: real writeFileSync content', () => {
  it('writes the exact input text to the scratch file for the scan to read', () => {
    const text = 'exact-content-check-12345';
    let readBack: string | undefined;
    const scan = (path: string): Finding[] | null => {
      readBack = readFileSync(path, 'utf8');
      return [];
    };
    redactWithGitleaks(text, scan);
    expect(readBack).toBe(text);
  });
});
