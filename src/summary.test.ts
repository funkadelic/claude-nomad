import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { emitSummary } from './summary.ts';

/**
 * Unit tests for `emitSummary`. The function is the single source of truth
 * for the end-of-run summary line emitted by cmdPull, cmdPush, and cmdDiff.
 * Clean outcomes go through `ok()` (green `✓` glyph, stdout); unmapped /
 * collision outcomes go through `warn()` (yellow `⚠︎` glyph, stderr). Tests
 * assert exact-string matches on the appropriate spy so any phrasing or
 * routing drift surfaces immediately.
 */
describe('emitSummary', () => {
  type LogSpy = MockInstance<(...args: unknown[]) => void>;
  type ErrorSpy = MockInstance<(...args: unknown[]) => void>;
  let logSpy: LogSpy;
  let errorSpy: ErrorSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Read the exact single argument passed to the most recent `console.log`. */
  function loggedLine(): string {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const firstArg = logSpy.mock.calls[0]?.[0];
    return typeof firstArg === 'string' ? firstArg : '';
  }

  /** Read the exact single argument passed to the most recent `console.error`. */
  function erroredLine(): string {
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const firstArg = errorSpy.mock.calls[0]?.[0];
    return typeof firstArg === 'string' ? firstArg : '';
  }

  it('pull with zero unmapped emits the clean line via ok()', () => {
    emitSummary('pull', 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('pull with three unmapped emits the unmapped-on-pull line via warn()', () => {
    emitSummary('pull', 3);
    expect(erroredLine()).toBe('⚠︎ summary: 3 unmapped on pull (run nomad doctor to list)');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('diff with zero unmapped emits the clean line via ok()', () => {
    emitSummary('diff', 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('diff with two unmapped emits the unmapped-on-diff line via warn()', () => {
    emitSummary('diff', 2);
    expect(erroredLine()).toBe('⚠︎ summary: 2 unmapped on diff (run nomad doctor to list)');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('push with zero unmapped and zero collisions emits the clean line via ok()', () => {
    emitSummary('push', 0, 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('push with one unmapped and zero collisions emits the unmapped-on-push line via warn()', () => {
    emitSummary('push', 1, 0);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('push with zero unmapped and two collisions emits the line with the collision count', () => {
    emitSummary('push', 0, 2);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 0 unmapped on push, 2 collisions (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('push with collisions parameter omitted defaults to zero', () => {
    emitSummary('push', 1);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits exactly one output per invocation (no duplicate lines)', () => {
    emitSummary('pull', 5);
    const total = logSpy.mock.calls.length + errorSpy.mock.calls.length;
    expect(total).toBe(1);
  });
});
