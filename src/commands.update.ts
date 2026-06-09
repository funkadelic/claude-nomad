import { execFileSync } from 'node:child_process';

import { type SpawnSyncFn } from './gh-actions.ts';
import { NomadFatal } from './utils.ts';

/**
 * Read the version string reported by the freshly-installed `nomad` binary.
 *
 * Spawns `nomad --version` via the injectable `run` and returns the trimmed
 * stdout string on success. Returns `null` on any error (spawn failure,
 * non-zero exit, or empty output) so callers can print a graceful fallback
 * without treating a query failure as an update failure.
 *
 * `nomad --version` prints a bare semver (e.g. `0.47.1`), so the caller is
 * responsible for adding any desired prefix (e.g. `v`).
 *
 * @param run - Subprocess runner; defaults to `execFileSync`. Inject a fake in
 *   tests to assert behavior without touching the real filesystem.
 */
export function readInstalledVersion(run: SpawnSyncFn = execFileSync): string | null {
  try {
    return run('nomad', ['--version'], { encoding: 'utf8' }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Update the claude-nomad CLI to the latest published npm release by running
 * `npm update -g claude-nomad`.
 *
 * Prints a status line before the update begins. After a successful npm
 * update, reads the newly-installed version by spawning the fresh `nomad
 * --version` binary (not the stale in-process `pkg.version`, which reflects
 * the OLD dist). Prints the version on success, or a graceful fallback line
 * if the version query fails.
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
  console.log('Updating claude-nomad CLI via npm...');
  try {
    run('npm', ['update', '-g', 'claude-nomad'], { stdio: 'inherit' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new NomadFatal('npm not found on PATH; install Node.js/npm and retry.');
    }
    throw new NomadFatal(`npm update -g claude-nomad failed: ${e.message}`);
  }
  const version = readInstalledVersion(run);
  if (version) {
    console.log(`claude-nomad is now at v${version}`);
  } else {
    console.log('Update complete. Run "nomad --version" to confirm the new version.');
  }
}
