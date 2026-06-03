/**
 * Worker-threads animation entry point for the progress spinner.
 *
 * Receives `{type:'start', label}` and `{type:'pause'}` messages from the main
 * thread via `parentPort`. On `start`, begins writing braille animation frames
 * to process.stderr at ~80 ms intervals using a `setInterval`. On `pause`,
 * clears the interval and stops drawing. The main thread then clears the
 * partial line and writes the final done line.
 *
 * The braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)
 * are the doctor-style glyph exception: they are typographic symbols used as
 * animation frames, not emoji.
 *
 * This file is the worker_threads entry point. It is bundled separately as
 * `dist/nomad.worker.mjs` by scripts/build.mjs. Coverage is excluded in
 * vitest.config.ts because worker entry points cannot be unit-instrumented.
 */

import { parentPort } from 'node:worker_threads';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/* c8 ignore start */
if (parentPort !== null) {
  parentPort.on('message', (msg: { type: string; label?: string }) => {
    if (msg.type === 'start' && msg.label !== undefined) {
      const label = msg.label;
      frame = 0;
      if (timer !== null) clearInterval(timer);
      timer = setInterval(() => {
        process.stderr.write(`${FRAMES[frame % FRAMES.length]} ${label}\r`);
        frame++;
      }, INTERVAL_MS);
    } else if (msg.type === 'pause') {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  });
}
/* c8 ignore stop */
