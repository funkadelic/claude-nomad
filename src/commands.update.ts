import { execFileSync } from 'node:child_process';

import { type SpawnSyncFn } from './gh-actions.ts';
import { NomadFatal } from './utils.ts';

/**
 * Update the claude-nomad CLI to the latest published npm release by running
 * `npm update -g claude-nomad`.
 *
 * Design decision D-01: self-update and data sync are separate concerns. This
 * command only updates the CLI binary; it does NOT run `nomad pull`, `nomad
 * doctor`, or any git operation. Use `nomad pull` after updating if you want
 * to sync config state.
 *
 * Uses an argv-array (no shell) with an injectable `run` for test isolation.
 *
 * @param run - Subprocess runner; defaults to `execFileSync`. Inject a fake in
 *   tests to assert the exact args without touching the real npm registry.
 */
export function cmdUpdate(run: SpawnSyncFn = execFileSync): void {
  try {
    run('npm', ['update', '-g', 'claude-nomad'], { stdio: 'inherit' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new NomadFatal('npm not found on PATH; install Node.js/npm and retry.');
    }
    throw new NomadFatal(`npm update -g claude-nomad failed: ${e.message}`);
  }
}
