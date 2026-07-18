import { describe, expect, it } from 'vitest';

import {
  buildCrashReport,
  CRASH_MAX_ARGV,
  CRASH_MAX_ARGV_TOKEN_LENGTH,
  CRASH_MAX_REPORT_BYTES,
  CRASH_MAX_STACK_LINES,
  scrubStructural,
  type CrashReportInput,
} from './crash-report.ts';

const BASE_INPUT: CrashReportInput = {
  err: new Error('boom'),
  argv: ['nomad', 'push'],
  version: '1.2.3',
  platform: 'linux',
  timestamp: '2026-07-17T00:00:00.000Z',
  homeDir: '/home/tester',
  hostLabel: 'test-host',
};

describe('scrubStructural', () => {
  it('replaces every occurrence of homeDir with ~', () => {
    const out = scrubStructural('/home/tester/a /home/tester/b', '/home/tester', '');
    expect(out).toBe('~/a ~/b');
  });

  it('replaces every occurrence of a non-empty hostLabel with <host>', () => {
    const out = scrubStructural('on test-host and test-host again', '', 'test-host');
    expect(out).toBe('on <host> and <host> again');
  });

  it('is a no-op for hostLabel when it is empty', () => {
    const out = scrubStructural('some text here', '', '');
    expect(out).toBe('some text here');
  });

  it('is a no-op for homeDir when it is empty (avoids corrupting text)', () => {
    const out = scrubStructural('some text here', '', 'test-host');
    expect(out).toBe('some text here');
  });

  it('applies both replacements regardless of order (order-independent)', () => {
    const text = '/home/tester/file.ts on test-host';
    const out = scrubStructural(text, '/home/tester', 'test-host');
    expect(out).toBe('~/file.ts on <host>');
  });
});

describe('buildCrashReport: basic shape', () => {
  it('includes version, command, error name/message, stack, platform, timestamp', () => {
    const report = buildCrashReport(BASE_INPUT);
    expect(report).toContain('version: 1.2.3');
    expect(report).toContain('command: nomad push');
    expect(report).toContain('error: Error: boom');
    expect(report).toContain('stack:');
    expect(report).toContain(`platform: linux (node ${process.version})`);
    expect(report).toContain('timestamp: 2026-07-17T00:00:00.000Z');
  });

  it('excludes any environment-variable dump', () => {
    const report = buildCrashReport(BASE_INPUT);
    expect(report).not.toContain('process.env');
  });

  it('returns text with homeDir already scrubbed to ~', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at /home/tester/src/nomad.ts:1:1';
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(report).not.toContain('/home/tester');
    expect(report).toContain('~/src/nomad.ts');
  });

  it('returns text with hostLabel already scrubbed to <host>', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    on test-host machine';
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(report).not.toContain('test-host machine');
    expect(report).toContain('<host> machine');
  });
});

describe('buildCrashReport: non-Error thrown values', () => {
  it('handles a string throw', () => {
    const report = buildCrashReport({ ...BASE_INPUT, err: 'plain string failure' });
    expect(report).toContain('error: NonErrorThrow: plain string failure');
    expect(report).toContain('(no stack available)');
  });

  it('handles a plain object throw via JSON.stringify', () => {
    const report = buildCrashReport({ ...BASE_INPUT, err: { code: 'EFAIL', detail: 'x' } });
    expect(report).toContain('error: NonErrorThrow:');
    expect(report).toContain('"code":"EFAIL"');
  });

  it('handles an undefined throw (JSON.stringify(undefined) is undefined, not a string)', () => {
    const report = buildCrashReport({ ...BASE_INPUT, err: undefined });
    expect(report).toContain('error: NonErrorThrow: undefined');
  });

  it('handles a circular object throw (JSON.stringify throws) via String() fallback', () => {
    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;
    const report = buildCrashReport({ ...BASE_INPUT, err: circular });
    expect(report).toContain('error: NonErrorThrow: [object Object]');
  });

  it('degrades to a placeholder when both JSON.stringify and String() throw', () => {
    // Circular so JSON.stringify throws, plus a throwing toString so the
    // String() fallback throws too: safeStringify must still not escape.
    const evil: Record<string, unknown> = {
      toString: () => {
        throw new Error('no string');
      },
    };
    evil.self = evil;
    const report = buildCrashReport({ ...BASE_INPUT, err: evil });
    expect(report).toContain('error: NonErrorThrow: (unstringifiable thrown value)');
  });

  it('degrades to a placeholder when an Error field getter throws', () => {
    const err = new Error('boom');
    // A hostile Error whose name getter throws must not abort report building;
    // normalizeError catches the read and substitutes a fixed placeholder.
    Object.defineProperty(err, 'name', {
      get() {
        throw new Error('trap');
      },
    });
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(report).toContain('error: Error: (unreadable Error)');
  });

  it('does not throw when a well-formed Error has its stack cleared', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(report).toContain('(no stack available)');
  });
});

describe('buildCrashReport: bounding', () => {
  it('caps the stack to CRASH_MAX_STACK_LINES lines', () => {
    const err = new Error('deep');
    const lines = Array.from({ length: CRASH_MAX_STACK_LINES + 20 }, (_, i) => `  at frame${i}`);
    err.stack = ['Error: deep', ...lines].join('\n');
    const report = buildCrashReport({ ...BASE_INPUT, err });
    // Only the first CRASH_MAX_STACK_LINES lines of err.stack survive.
    expect(report).toContain('frame0');
    expect(report).toContain(`frame${CRASH_MAX_STACK_LINES - 2}`);
    expect(report).not.toContain(`frame${CRASH_MAX_STACK_LINES + 5}`);
  });

  it('caps argv to CRASH_MAX_ARGV tokens', () => {
    const argv = Array.from({ length: CRASH_MAX_ARGV + 10 }, (_, i) => `arg${i}`);
    const report = buildCrashReport({ ...BASE_INPUT, argv });
    expect(report).toContain(`arg${CRASH_MAX_ARGV - 1}`);
    expect(report).not.toContain(`arg${CRASH_MAX_ARGV + 5}`);
  });

  it('length-clamps a single argv token longer than CRASH_MAX_ARGV_TOKEN_LENGTH', () => {
    const longToken = 'x'.repeat(CRASH_MAX_ARGV_TOKEN_LENGTH + 50);
    const report = buildCrashReport({ ...BASE_INPUT, argv: [longToken] });
    expect(report).toContain('x'.repeat(CRASH_MAX_ARGV_TOKEN_LENGTH) + '...');
    expect(report).not.toContain(longToken);
  });

  it('does not clamp an argv token at or under the length cap', () => {
    const exactToken = 'y'.repeat(CRASH_MAX_ARGV_TOKEN_LENGTH);
    const report = buildCrashReport({ ...BASE_INPUT, argv: [exactToken] });
    expect(report).toContain(exactToken);
    expect(report).not.toContain(exactToken + '...');
  });

  it('truncates the whole report to CRASH_MAX_REPORT_BYTES with a truncation marker', () => {
    const err = new Error('huge');
    // A single stack line far larger than the byte cap; line-count capping
    // alone would not bound it, so the byte-truncation path must fire.
    err.stack = 'Error: huge\n' + 'a'.repeat(CRASH_MAX_REPORT_BYTES * 2);
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(CRASH_MAX_REPORT_BYTES);
    expect(report).toContain('[... truncated ...]');
  });

  it('scrubs homeDir occurrences that straddle the truncation boundary (scrub before truncate)', () => {
    const homeDir = '/home/SECRETUSER';
    // Repeat homeDir across more than twice the byte cap so at least one
    // occurrence straddles the truncation boundary. If truncation ran BEFORE
    // scrubbing, the straddling occurrence would be sliced into a partial the
    // exact-match scrub cannot catch, leaking a '/home/...' fragment.
    const chunk = homeDir + 'x'.repeat(64);
    const err = new Error('boundary');
    err.stack =
      'Error: boundary\n' + chunk.repeat(Math.ceil((CRASH_MAX_REPORT_BYTES * 2) / chunk.length));
    const report = buildCrashReport({ ...BASE_INPUT, err, homeDir, hostLabel: '' });
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(CRASH_MAX_REPORT_BYTES);
    // Every occurrence became '~' before truncation, so no home-path fragment
    // (full or sliced) can survive.
    expect(report).not.toContain('/home/');
    expect(report).not.toContain('SECRET');
  });

  it('trims multi-byte characters down to the exact byte budget (not just character count)', () => {
    const err = new Error('huge-multibyte');
    // 'é' is 2 bytes in UTF-8: slicing by character count alone overshoots
    // the byte budget, so the char-by-char trim loop must run to convergence.
    err.stack = 'Error: huge-multibyte\n' + 'é'.repeat(CRASH_MAX_REPORT_BYTES * 2);
    const report = buildCrashReport({ ...BASE_INPUT, err });
    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(CRASH_MAX_REPORT_BYTES);
    expect(report).toContain('[... truncated ...]');
  });

  it('does not truncate a report already within the byte cap', () => {
    const report = buildCrashReport(BASE_INPUT);
    expect(report).not.toContain('[... truncated ...]');
  });
});
