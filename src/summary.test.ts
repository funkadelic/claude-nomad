import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { emitSummary, summaryRow, summaryText } from './summary.ts';

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

  // Extras-skipped widening: the fourth positional argument carries the count
  // of extras dirs the runtime declined to sync (per-project whitelist misses
  // surfaced by `remapExtrasPush` / `remapExtrasPull` / `divergenceCheckExtras`).
  // The default value is 0 so legacy three-arg call sites stay clean.
  it('pull clean with zero extras-skipped still emits the clean line', () => {
    emitSummary('pull', 0, 0, 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('pull with zero unmapped and two extras-skipped emits the extras-skipped WARN', () => {
    emitSummary('pull', 0, 0, 2);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 0 unmapped on pull, 2 extras skipped (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('pull with one unmapped and two extras-skipped emits both counts in the WARN', () => {
    emitSummary('pull', 1, 0, 2);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 1 unmapped on pull, 2 extras skipped (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('push with one extras-skipped folds into the existing collisions WARN line', () => {
    emitSummary('push', 0, 0, 1);
    expect(erroredLine()).toBe(
      '⚠︎ summary: 0 unmapped on push, 0 collisions, 1 extras skipped (run nomad doctor to list)',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('push clean path stays clean when extras-skipped is zero', () => {
    emitSummary('push', 0, 0, 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('legacy three-arg pull call still produces the clean line via default', () => {
    // Default `extrasSkipped = 0` preserves back-compat for the existing call
    // sites in cmdPull / cmdPush / cmdDiff that have not yet been widened.
    emitSummary('pull', 0);
    expect(loggedLine()).toMatch(/^✓\s+summary: clean$/);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the pure phrasing core `summaryText` and the rendered-row
 * helper `summaryRow`. These back the grouped push/pull tree's Summary section
 * and must phrase outcomes identically to `emitSummary` so the standalone
 * cmdDiff line and the in-tree row never drift. `summaryRow` now renders plain
 * text (no status glyph), so the rendered row equals the bare message with the
 * "summary: " prefix stripped.
 */
describe('summaryText', () => {
  it('pull clean returns the clean text and clean=true', () => {
    expect(summaryText('pull', 0)).toEqual({ text: 'summary: clean', clean: true });
  });

  it('pull with unmapped returns the unmapped-on-pull text and clean=false', () => {
    expect(summaryText('pull', 3)).toEqual({
      text: 'summary: 3 unmapped on pull (run nomad doctor to list)',
      clean: false,
    });
  });

  it('pull with extras-skipped folds the count into the warning text', () => {
    expect(summaryText('pull', 1, 0, 2)).toEqual({
      text: 'summary: 1 unmapped on pull, 2 extras skipped (run nomad doctor to list)',
      clean: false,
    });
  });

  it('diff clean and diff with unmapped phrase the same as pull but with the diff verb', () => {
    expect(summaryText('diff', 0)).toEqual({ text: 'summary: clean', clean: true });
    expect(summaryText('diff', 2)).toEqual({
      text: 'summary: 2 unmapped on diff (run nomad doctor to list)',
      clean: false,
    });
  });

  it('push clean returns the clean text', () => {
    expect(summaryText('push', 0, 0, 0)).toEqual({ text: 'summary: clean', clean: true });
  });

  it('push with collisions includes the collision count', () => {
    expect(summaryText('push', 1, 0)).toEqual({
      text: 'summary: 1 unmapped on push, 0 collisions (run nomad doctor to list)',
      clean: false,
    });
  });

  it('push with collisions and extras-skipped includes both counts', () => {
    expect(summaryText('push', 0, 2, 1)).toEqual({
      text: 'summary: 0 unmapped on push, 2 collisions, 1 extras skipped (run nomad doctor to list)',
      clean: false,
    });
  });

  // local-only (D-06): the fifth positional argument carries the count of
  // session files retained on the host but absent from the repo. Pull/diff
  // report it as a non-clean WARN; push always passes 0 (phrasing unchanged).
  it('pull with only local-only present is non-clean and names the count + reconcile hint', () => {
    expect(summaryText('pull', 0, 0, 0, 2)).toEqual({
      text: 'summary: 0 unmapped on pull (run nomad doctor to list), 2 local-only present (push to reconcile)',
      clean: false,
    });
  });

  it('pull clean stays clean when local-only is zero', () => {
    expect(summaryText('pull', 0, 0, 0, 0)).toEqual({ text: 'summary: clean', clean: true });
  });

  it('pull folds local-only alongside unmapped and extras-skipped', () => {
    expect(summaryText('pull', 1, 0, 2, 3)).toEqual({
      text: 'summary: 1 unmapped on pull, 2 extras skipped (run nomad doctor to list), 3 local-only present (push to reconcile)',
      clean: false,
    });
  });

  it('diff surfaces local-only the same way as pull', () => {
    expect(summaryText('diff', 0, 0, 0, 4)).toEqual({
      text: 'summary: 0 unmapped on diff (run nomad doctor to list), 4 local-only present (push to reconcile)',
      clean: false,
    });
  });

  it('push ignores local-only and stays clean (push always passes 0)', () => {
    expect(summaryText('push', 0, 0, 0, 0)).toEqual({ text: 'summary: clean', clean: true });
  });
});

describe('summaryRow', () => {
  it('renders the clean outcome as plain text', () => {
    expect(summaryRow('pull', 0)).toBe('clean');
  });

  it('renders a pull warning outcome as plain text', () => {
    expect(summaryRow('pull', 3)).toBe('3 unmapped on pull (run nomad doctor to list)');
  });

  it('renders the push clean outcome as plain text', () => {
    expect(summaryRow('push', 0, 0, 0)).toBe('clean');
  });

  it('renders a push warning outcome (collisions + extras) as plain text', () => {
    expect(summaryRow('push', 1, 2, 3)).toBe(
      '1 unmapped on push, 2 collisions, 3 extras skipped (run nomad doctor to list)',
    );
  });

  it('renders a pull local-only outcome as non-clean plain text (D-06)', () => {
    const row = summaryRow('pull', 0, 0, 0, 2);
    expect(row).not.toBe('clean');
    expect(row).toContain('2 local-only present');
    expect(row).toContain('push to reconcile');
  });

  it('renders push unchanged when local-only defaults to 0', () => {
    expect(summaryRow('push', 0, 0, 0)).toBe('clean');
  });
});
