import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { emitSummary } from './summary.ts';

/**
 * Unit tests for `emitSummary`. The function is the single source of truth
 * for the end-of-run summary line emitted by cmdPull, cmdPush, and cmdDiff.
 * Tests assert exact-string matches on the `console.log` spy so any phrasing
 * drift surfaces immediately.
 */
describe('emitSummary', () => {
  type LogSpy = MockInstance<(...args: unknown[]) => void>;
  let logSpy: LogSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: read the exact single argument passed to `log()` from the spy.
   * `log()` prepends `[nomad] `, so the spy sees `'[nomad] <msg>'` as a
   * single concatenated string.
   */
  function loggedLine(): string {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const args = logSpy.mock.calls[0];
    return args !== undefined ? String(args[0]) : '';
  }

  it('pull with zero unmapped emits the clean line', () => {
    emitSummary('pull', 0);
    expect(loggedLine()).toBe('[nomad] summary: clean');
  });

  it('pull with three unmapped emits the unmapped-on-pull line', () => {
    emitSummary('pull', 3);
    expect(loggedLine()).toBe('[nomad] summary: 3 unmapped on pull (run nomad doctor to list)');
  });

  it('diff with zero unmapped emits the clean line', () => {
    emitSummary('diff', 0);
    expect(loggedLine()).toBe('[nomad] summary: clean');
  });

  it('diff with two unmapped emits the unmapped-on-diff line', () => {
    emitSummary('diff', 2);
    expect(loggedLine()).toBe('[nomad] summary: 2 unmapped on diff (run nomad doctor to list)');
  });

  it('push with zero unmapped and zero collisions emits the clean line', () => {
    emitSummary('push', 0, 0);
    expect(loggedLine()).toBe('[nomad] summary: clean');
  });

  it('push with one unmapped and zero collisions emits the unmapped-on-push line', () => {
    emitSummary('push', 1, 0);
    expect(loggedLine()).toBe(
      '[nomad] summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
  });

  it('push with zero unmapped and two collisions emits the line with the collision count', () => {
    emitSummary('push', 0, 2);
    expect(loggedLine()).toBe(
      '[nomad] summary: 0 unmapped on push, 2 collisions (run nomad doctor to list)',
    );
  });

  it('push with collisions parameter omitted defaults to zero', () => {
    emitSummary('push', 1);
    expect(loggedLine()).toBe(
      '[nomad] summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
    );
  });

  it('emits exactly one log call per invocation (no duplicate lines)', () => {
    emitSummary('pull', 5);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
