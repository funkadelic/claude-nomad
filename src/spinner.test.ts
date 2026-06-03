/**
 * Unit tests for src/spinner.ts.
 *
 * All tests use injected fakes: no real worker is spawned, no real TTY is
 * required. The suite covers every branch: TTY animated path, non-TTY plain
 * path, CI env plain path, worker-spawn-failure degradation, stop/elapsed
 * formatting, worker terminate/unref on teardown, and both resolveWorkerPath
 * candidates (mjs present = published, mjs absent = dev ts).
 */

import { describe, expect, it, vi } from 'vitest';

import { resolveWorkerPath, startSpinner } from './spinner.ts';
import type { SpinnerDeps, SpinnerWorker } from './spinner.ts';

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake output stream that accumulates everything written to it.
 *
 * @returns A `{ write }` sink whose captured text is read via `capturedOutput`.
 */
function makeOut(): { write: (s: string) => void; captured: string } {
  const buf = { captured: '' };
  return {
    write(s: string) {
      buf.captured += s;
    },
    captured: buf.captured,
    get _captured() {
      return buf.captured;
    },
  } as unknown as { write: (s: string) => void; captured: string };
}

/**
 * Read the accumulated text written to a {@link makeOut} fake stream.
 *
 * @param out The fake stream returned by `makeOut`.
 * @returns Everything written so far, concatenated.
 */
function capturedOutput(out: ReturnType<typeof makeOut>): string {
  return (out as unknown as { _captured: string })._captured;
}

/**
 * Build a fake `SpinnerWorker` that records messages and call counts.
 *
 * @returns The fake `worker` (with `messages`, `terminateCalled`,
 *   `terminateCount`, `unrefCalled` introspection) and a `factory` that returns it.
 */
function makeWorkerFake(): {
  worker: SpinnerWorker & {
    messages: unknown[];
    terminateCalled: boolean;
    terminateCount: number;
    unrefCalled: boolean;
  };
  factory: () => SpinnerWorker;
} {
  const messages: unknown[] = [];
  let terminateCount = 0;
  let unrefCalled = false;
  const worker: SpinnerWorker & {
    messages: unknown[];
    terminateCalled: boolean;
    terminateCount: number;
    unrefCalled: boolean;
  } = {
    messages,
    get terminateCalled() {
      return terminateCount > 0;
    },
    get terminateCount() {
      return terminateCount;
    },
    get unrefCalled() {
      return unrefCalled;
    },
    postMessage(msg) {
      messages.push(msg);
    },
    terminate() {
      terminateCount += 1;
    },
    unref() {
      unrefCalled = true;
    },
  };
  return { worker, factory: () => worker };
}

/** Count occurrences of {type:'pause'} messages posted to a fake worker. */
function pauseCount(messages: unknown[]): number {
  return messages.filter((m) => (m as { type?: string })?.type === 'pause').length;
}

/** Fixed clock returning increasing times. */
function makeClock(startMs = 1000, delta = 1200): () => number {
  let call = 0;
  return () => (call++ === 0 ? startMs : startMs + delta);
}

// ---------------------------------------------------------------------------
// resolveWorkerPath
// ---------------------------------------------------------------------------

describe('resolveWorkerPath', () => {
  it('returns the .mjs sibling when existsSync returns true for it', () => {
    const result = resolveWorkerPath({
      existsSyncFn: (p) => p.endsWith('.mjs'),
      baseUrl: 'file:///dist/nomad.mjs',
    });
    expect(result).toMatch(/nomad\.worker\.mjs$/);
  });

  it('returns the .ts sibling when .mjs does not exist (dev path)', () => {
    const result = resolveWorkerPath({
      existsSyncFn: () => false,
      baseUrl: 'file:///src/nomad.ts',
    });
    expect(result).toMatch(/spinner\.worker\.ts$/);
  });

  it('uses real existsSync and import.meta.url when no deps injected (covers ?? defaults)', () => {
    // The result is either the .mjs or the .ts sibling depending on build state.
    // We only verify it returns a string ending in a known extension.
    const result = resolveWorkerPath();
    expect(result).toMatch(/\.(mjs|ts)$/);
  });
});

// ---------------------------------------------------------------------------
// Non-TTY / CI plain path
// ---------------------------------------------------------------------------

describe('startSpinner (non-TTY plain path)', () => {
  /**
   * Build deps forcing the plain (non-TTY) path with a capturing out stream.
   *
   * @param envOverride Optional process env override (default: empty).
   * @returns Spinner deps plus the capturing `out` stream.
   */
  function makePlainDeps(envOverride: NodeJS.ProcessEnv = {}): SpinnerDeps & {
    out: ReturnType<typeof makeOut>;
  } {
    const out = makeOut();
    return {
      isTTYCheck: () => false,
      env: envOverride,
      out,
      now: makeClock(),
    };
  }

  it('writes "<label>..." on start, no control codes', () => {
    const deps = makePlainDeps();
    startSpinner('Pushing', deps);
    expect(capturedOutput(deps.out)).toBe('Pushing...\n');
  });

  it('writes "<label> done (Xs)" on succeed, no control codes', () => {
    const deps = makePlainDeps();
    const h = startSpinner('Rebasing onto origin', deps);
    h.succeed();
    const out = capturedOutput(deps.out);
    expect(out).toContain('Rebasing onto origin done (1.2s)');
    expect(out.includes('\x1b')).toBe(false);
    expect(out.includes('\r')).toBe(false);
  });

  it('stop() without succeed writes no done line (abort path)', () => {
    const deps = makePlainDeps();
    const h = startSpinner('Pushing', deps);
    h.stop();
    // Only the start line was written; an aborted step shows no "done".
    expect(capturedOutput(deps.out)).toBe('Pushing...\n');
  });

  it('uses doneLabel override when provided to succeed()', () => {
    const deps = makePlainDeps();
    const h = startSpinner('Scanning', deps);
    h.succeed('Done scanning');
    expect(capturedOutput(deps.out)).toContain('Done scanning done (1.2s)');
  });

  it('plain path when CI is set, even if isTTYCheck returns true', () => {
    const out = makeOut();
    const deps: SpinnerDeps = {
      isTTYCheck: () => true,
      env: { CI: '1' },
      out,
      now: makeClock(),
    };
    const h = startSpinner('Pushing', deps);
    expect(capturedOutput(out)).toBe('Pushing...\n');
    h.succeed();
    expect(capturedOutput(out)).toContain('Pushing done (');
    expect(capturedOutput(out).includes('\x1b')).toBe(false);
  });

  it('no worker factory called on non-TTY path', () => {
    const makeWorkerSpy = vi.fn(() => makeWorkerFake().worker);
    const out = makeOut();
    startSpinner('Pushing', {
      isTTYCheck: () => false,
      env: {},
      out,
      makeWorker: makeWorkerSpy,
      now: makeClock(),
    });
    expect(makeWorkerSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TTY animated path
// ---------------------------------------------------------------------------

describe('startSpinner (TTY animated path)', () => {
  /**
   * Build deps forcing the TTY animated path with a fake worker and out stream.
   *
   * @returns Spinner deps plus the capturing `out` stream and the `fakeWorker`.
   */
  function makeAnimatedDeps(): SpinnerDeps & {
    out: ReturnType<typeof makeOut>;
    fakeWorker: ReturnType<typeof makeWorkerFake>['worker'];
  } {
    const out = makeOut();
    const { worker, factory } = makeWorkerFake();
    return {
      isTTYCheck: () => true,
      env: {},
      out,
      makeWorker: factory,
      now: makeClock(),
      fakeWorker: worker,
    };
  }

  it('posts {type:"start", label} to worker on start', () => {
    const deps = makeAnimatedDeps();
    startSpinner('Pushing', deps);
    expect(deps.fakeWorker.messages[0]).toEqual({ type: 'start', label: 'Pushing' });
  });

  it('calls worker.unref() on start so worker does not block exit', () => {
    const deps = makeAnimatedDeps();
    startSpinner('Pushing', deps);
    expect(deps.fakeWorker.unrefCalled).toBe(true);
  });

  it('posts {type:"pause"} and clears line on succeed()', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Pushing', deps);
    h.succeed();
    expect(deps.fakeWorker.messages).toContainEqual({ type: 'pause' });
    const out = capturedOutput(deps.out);
    expect(out).toContain('\r');
    expect(out.includes('\x1b[K')).toBe(true);
  });

  it('writes glyph + label + elapsed on succeed()', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Pushing', deps);
    h.succeed();
    const out = capturedOutput(deps.out);
    expect(out).toMatch(/Pushing \(1\.2s\)/);
  });

  it('stop() without succeed clears the line but writes no glyph/elapsed (abort)', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Pushing', deps);
    h.stop();
    expect(deps.fakeWorker.messages).toContainEqual({ type: 'pause' });
    const out = capturedOutput(deps.out);
    expect(out).toContain('\r');
    expect(out.includes('\x1b[K')).toBe(true);
    // No success line: neither the label-with-elapsed nor a glyph.
    expect(out).not.toMatch(/\(1\.2s\)/);
    expect(deps.fakeWorker.terminateCalled).toBe(true);
  });

  it('calls worker.terminate() on succeed()', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Pushing', deps);
    h.succeed();
    expect(deps.fakeWorker.terminateCalled).toBe(true);
  });

  it('succeed() then stop() is idempotent: one pause, one terminate, no extra output', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Pushing', deps);
    h.succeed();
    const afterSucceed = capturedOutput(deps.out);
    h.stop();
    expect(capturedOutput(deps.out)).toBe(afterSucceed);
    expect(pauseCount(deps.fakeWorker.messages)).toBe(1);
    expect(deps.fakeWorker.terminateCount).toBe(1);
  });

  it('writes no start line on animated path (worker owns animation)', () => {
    const deps = makeAnimatedDeps();
    startSpinner('Pushing', deps);
    // Only the worker messages are sent; no plain "Pushing..." written
    expect(capturedOutput(deps.out)).toBe('');
  });

  it('succeed() uses doneLabel when provided', () => {
    const deps = makeAnimatedDeps();
    const h = startSpinner('Scanning', deps);
    h.succeed('Scan complete');
    expect(capturedOutput(deps.out)).toMatch(/Scan complete \(1\.2s\)/);
  });

  it('works when worker has no unref method', () => {
    const out = makeOut();
    const messages: unknown[] = [];
    let terminateCalled = false;
    // Worker without unref (unref is optional on SpinnerWorker)
    const workerNoUnref: SpinnerWorker = {
      postMessage(msg) {
        messages.push(msg);
      },
      terminate() {
        terminateCalled = true;
      },
    };
    const h = startSpinner('Pushing', {
      isTTYCheck: () => true,
      env: {},
      out,
      makeWorker: () => workerNoUnref,
      now: makeClock(),
    });
    h.stop();
    expect(terminateCalled).toBe(true);
    expect(messages).toContainEqual({ type: 'start', label: 'Pushing' });
  });

  it('writes plain okGlyph (no color) when isTTYCheck returns false at stop time', () => {
    // Cover the `useTTY ? green(okGlyph) : okGlyph` false branch in writeAnimatedDone.
    // This occurs when the spinner was started on TTY but by stop time isTTYCheck
    // returns false (edge case; also exercises the branch for completeness).
    const out = makeOut();
    const { factory } = makeWorkerFake();
    let callCount = 0;
    const h = startSpinner('Pushing', {
      // Returns true on start (to go into animated path), false at finalize time
      isTTYCheck: () => callCount++ === 0,
      env: {},
      out,
      makeWorker: factory,
      now: makeClock(),
    });
    h.succeed();
    const result = capturedOutput(out);
    expect(result).toContain('Pushing (1.2s)');
  });
});

// ---------------------------------------------------------------------------
// Worker-spawn failure (degraded plain fallback)
// ---------------------------------------------------------------------------

describe('startSpinner (worker-spawn failure degraded path)', () => {
  /**
   * Build deps whose worker factory throws, to exercise the degraded fallback.
   *
   * @returns Spinner deps with a throwing `makeWorker` and a capturing `out`.
   */
  function makeFailingWorkerDeps(): SpinnerDeps & { out: ReturnType<typeof makeOut> } {
    const out = makeOut();
    return {
      isTTYCheck: () => true,
      env: {},
      out,
      makeWorker: () => {
        throw new Error('spawn failed');
      },
      now: makeClock(),
    };
  }

  it('silently falls back to plain start line on worker spawn failure', () => {
    const deps = makeFailingWorkerDeps();
    startSpinner('Pushing', deps);
    expect(capturedOutput(deps.out)).toBe('Pushing...\n');
  });

  it('writes plain done line on succeed() after spawn failure', () => {
    const deps = makeFailingWorkerDeps();
    const h = startSpinner('Pushing', deps);
    h.succeed();
    const out = capturedOutput(deps.out);
    expect(out).toContain('Pushing done (1.2s)');
    expect(out.includes('\x1b')).toBe(false);
  });

  it('stop() after spawn failure writes no done line (abort, plain)', () => {
    const deps = makeFailingWorkerDeps();
    const h = startSpinner('Pushing', deps);
    h.stop();
    // Degraded to plain start; an aborted step adds no "done" line.
    expect(capturedOutput(deps.out)).toBe('Pushing...\n');
  });

  it('does not throw from startSpinner on spawn failure', () => {
    const deps = makeFailingWorkerDeps();
    expect(() => startSpinner('Pushing', deps)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Default dep fallbacks (covers ?? branches for process.env, process.stderr,
// Date.now, and isTTY real defaults)
// ---------------------------------------------------------------------------

describe('startSpinner (default dep fallbacks)', () => {
  it('uses process.env, process.stderr, Date.now defaults without deps injection', () => {
    // Covers the ?? right-side branches: env=process.env, out=process.stderr,
    // now=Date.now, isTTYCheck=() => isTTY().
    // process.stderr.write is real; CI env is set in this test env so it goes
    // through the plain path (no worker spawn). We redirect stderr to intercept.
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrAny = process.stderr as unknown as { write: (s: string) => boolean };
    stderrAny.write = (s: string) => {
      writes.push(s);
      return true;
    };
    const origCI = process.env.CI;
    // Force non-animated path by setting CI so no worker spawns
    process.env.CI = '1';
    try {
      const h = startSpinner('DefaultTest');
      h.succeed();
    } finally {
      stderrAny.write = origWrite;
      if (origCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = origCI;
      }
    }
    expect(writes.some((s) => s.includes('DefaultTest...'))).toBe(true);
    expect(writes.some((s) => s.includes('DefaultTest done ('))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Elapsed formatting
// ---------------------------------------------------------------------------

describe('startSpinner elapsed formatting', () => {
  it('formats sub-second elapsed as "0.1s" etc.', () => {
    const out = makeOut();
    const h = startSpinner('Pushing', {
      isTTYCheck: () => false,
      env: {},
      out,
      now: makeClock(1000, 100),
    });
    h.succeed();
    expect(capturedOutput(out)).toContain('0.1s');
  });

  it('formats multi-second elapsed correctly', () => {
    const out = makeOut();
    const h = startSpinner('Pushing', {
      isTTYCheck: () => false,
      env: {},
      out,
      now: makeClock(1000, 5500),
    });
    h.succeed();
    expect(capturedOutput(out)).toContain('5.5s');
  });
});
