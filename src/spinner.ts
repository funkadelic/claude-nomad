/**
 * Animated progress spinner for long-running synchronous operations.
 *
 * On an interactive TTY (stdin+stdout both TTY, CI env unset), `startSpinner`
 * posts a `{type:'start', label}` message to a `worker_threads` worker that
 * writes braille animation frames to stderr. The worker keeps animating while
 * the main thread is blocked inside `execFileSync`. On `stop()`, the main
 * thread clears the animated line and writes a final `<glyph> <label> (elapsed)`
 * line.
 *
 * On non-TTY or CI the plain fallback is used: `startSpinner` writes
 * `"<label>..."` once; `stop()` writes `"<label> done (elapsed)"`. Both lines
 * are control-code-free and grep-stable.
 *
 * Worker spawn failure is caught and silently degrades to the plain fallback so
 * the operation still completes.
 *
 * The explicit `stop()` / teardown path calls `worker.terminate()` and
 * `worker.unref?.()` so no dangling worker keeps the event loop alive.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { green, okGlyph } from './color.ts';
import { isTTY } from './commands.push.recovery.ts';

/** Minimal structural interface satisfied by a real `worker_threads.Worker`. */
export type SpinnerWorker = {
  postMessage(msg: unknown): void;
  terminate(): void;
  unref?(): void;
};

/** Dependency injection seams for unit testing. */
export type SpinnerDeps = {
  /** TTY detection override (default: `isTTY()`). */
  isTTYCheck?: () => boolean;
  /** Process env override (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Output stream override (default: `process.stderr`). */
  out?: { write(s: string): void };
  /** Worker factory override (default: real Worker constructor). */
  makeWorker?: () => SpinnerWorker;
  /** Clock override (default: `Date.now`). */
  now?: () => number;
};

/** Handle returned by `startSpinner`. */
export type SpinnerHandle = {
  /**
   * Finalize with success: clears the animated line and writes
   * `"<glyph> <label> (elapsed)"` on TTY, or `"<label> done (elapsed)"` on the
   * plain path, then terminates the worker. Idempotent.
   *
   * @param doneLabel Optional override label for the done line (default: start label).
   */
  succeed(doneLabel?: string): void;
  /**
   * Idempotent cleanup, safe to call unconditionally in a `finally`. If
   * `succeed` already ran it is a no-op; otherwise (the wrapped call threw) it
   * clears the animated line WITHOUT a success glyph and terminates the worker,
   * so a failed step never shows a check mark. The original error propagates.
   */
  stop(): void;
};

/** Format elapsed milliseconds as `"1.2s"`. */
function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Write a plain (no ANSI) start line for non-TTY/CI paths. */
function writePlainStart(out: { write(s: string): void }, label: string): void {
  out.write(`${label}...\n`);
}

/** Write a plain (no ANSI) done line for non-TTY/CI paths. */
function writePlainDone(out: { write(s: string): void }, label: string, ms: number): void {
  out.write(`${label} done (${formatElapsed(ms)})\n`);
}

/** Write the animated final line: clear spinner line, print success. */
function writeAnimatedDone(
  out: { write(s: string): void },
  label: string,
  ms: number,
  useTTY: boolean,
): void {
  // \r\x1b[K: carriage return + erase to end of line (clears the spinner frame)
  out.write('\r\x1b[K');
  const glyph = useTTY ? green(okGlyph) : okGlyph;
  out.write(`${glyph} ${label} (${formatElapsed(ms)})\n`);
}

/**
 * Resolve the worker file path. Picks `./nomad.worker.mjs` (the compiled
 * bundle sibling) when it exists via `existsSync`, else `./spinner.worker.ts`
 * (local dev, native type-strip). Exported for unit testing via injected deps.
 *
 * @param deps.existsSyncFn Injectable `existsSync`-compatible check (default: node:fs existsSync).
 * @param deps.baseUrl Injectable base URL string (default: `import.meta.url`).
 * @returns Absolute file path string.
 */
export function resolveWorkerPath(
  deps: {
    existsSyncFn?: (p: string) => boolean;
    baseUrl?: string;
  } = {},
): string {
  const check = deps.existsSyncFn ?? existsSync;
  const base = deps.baseUrl ?? import.meta.url;
  const mjs = fileURLToPath(new URL('./nomad.worker.mjs', base));
  if (check(mjs)) return mjs;
  return fileURLToPath(new URL('./spinner.worker.ts', base));
}

/* c8 ignore start */
/** Build the real worker factory (lazily, on first animated start). */
function makeRealWorker(): SpinnerWorker {
  return new Worker(resolveWorkerPath());
}
/* c8 ignore stop */

/**
 * Start a progress spinner for `label`. Returns a `SpinnerHandle` whose
 * `stop()` / `succeed()` finalizes the line.
 *
 * On TTY with CI unset: animates via a worker_threads worker.
 * Otherwise: plain `"<label>...\n"` on start, `"<label> done (Xs)\n"` on stop.
 *
 * @param label Short description of the in-progress step (e.g., "Pushing").
 * @param deps Optional injected dependencies for testing.
 * @returns SpinnerHandle with `stop` and `succeed`.
 */
export function startSpinner(label: string, deps: SpinnerDeps = {}): SpinnerHandle {
  const ttyCheck = deps.isTTYCheck ?? (() => isTTY());
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stderr;
  const now = deps.now ?? Date.now;
  const startMs = now();

  const animate = ttyCheck() && !env.CI;

  let worker: SpinnerWorker | null = null;
  let degraded = false;
  let finalized = false;

  if (animate) {
    /* c8 ignore start */
    const factory = deps.makeWorker ?? makeRealWorker;
    /* c8 ignore stop */
    try {
      worker = factory();
      worker.unref?.();
      worker.postMessage({ type: 'start', label });
    } catch {
      degraded = true;
      worker = null;
      writePlainStart(out, label);
    }
  } else {
    writePlainStart(out, label);
  }

  // Finalize once. `success` controls whether a done line / success glyph is
  // emitted; a `stop()` after a thrown call passes `false` so no check mark
  // appears. Either way the worker is paused and terminated exactly once.
  function finalize(success: boolean, doneLabel?: string): void {
    if (finalized) return;
    finalized = true;
    const dl = doneLabel ?? label;
    const elapsed = now() - startMs;
    if (animate && !degraded && worker !== null) {
      worker.postMessage({ type: 'pause' });
      // \r\x1b[K: carriage return + erase to end of line (clears the frame).
      if (success) writeAnimatedDone(out, dl, elapsed, ttyCheck());
      else out.write('\r\x1b[K');
      worker.terminate();
      worker = null;
    } else if (success) {
      writePlainDone(out, dl, elapsed);
    }
  }

  return {
    succeed: (doneLabel?: string) => finalize(true, doneLabel),
    stop: () => finalize(false),
  };
}
