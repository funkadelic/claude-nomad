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
 * On win32, `nomad` resolves to the `nomad.cmd` batch shim, and spawning a
 * `.cmd` file without `shell: true` throws `EINVAL` on current Node
 * releases (mirrors `cmdUpdate`'s own `npm.cmd` treatment below). The args
 * array stays the fixed literal `['--version']` (never user or
 * config-derived), so `shell: true` introduces no command-injection surface
 * here.
 *
 * @param run - Subprocess runner; defaults to `execFileSync`. Inject a fake in
 *   tests to assert behavior without touching the real filesystem.
 */
export function readInstalledVersion(run: SpawnSyncFn = execFileSync): string | null {
  const isWin = process.platform === 'win32';
  try {
    return (
      run(isWin ? 'nomad.cmd' : 'nomad', ['--version'], {
        encoding: 'utf8',
        ...(isWin ? { shell: true } : {}),
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Update the claude-nomad CLI to the latest published npm release by running
 * `npm update -g claude-nomad`.
 *
 * Prints a status line showing the current version before the update begins.
 * The npm subprocess output is captured (not streamed) so a successful update
 * stays quiet, leaving only the final version line. After a successful npm
 * update, reads the newly-installed version by spawning the fresh `nomad
 * --version` binary (not the stale in-process `currentVersion`, which reflects
 * the OLD dist). Prints the version on success, or a graceful fallback line
 * if the version query fails. On npm failure the captured stderr is folded
 * into the error so the cause stays diagnosable despite the silenced output.
 *
 * Self-update and data sync are separate concerns. This
 * command only updates the CLI binary; it does NOT run `nomad pull`, `nomad
 * doctor`, or any git operation. Use `nomad pull` after updating if you want
 * to sync config state.
 *
 * Uses an argv-array (no shell) with an injectable `run` for test isolation,
 * except on win32 where `shell: true` is required (see below).
 *
 * On win32, `npm` resolves to the `npm.cmd` batch shim, and spawning a
 * `.cmd` file without `shell: true` throws `EINVAL` on current Node
 * releases. The args array stays the fixed literal
 * `['update', '-g', 'claude-nomad']` (never user or config-derived), so
 * `shell: true` introduces no command-injection surface here; do not reuse
 * this pattern for a spawn whose arguments come from user input or config.
 *
 * @param currentVersion - The in-process package version (the OLD dist), shown
 *   in the pre-update status line.
 * @param run - Subprocess runner; defaults to `execFileSync`. Inject a fake in
 *   tests to assert the exact args without touching the real npm registry.
 */
export function cmdUpdate(currentVersion: string, run: SpawnSyncFn = execFileSync): void {
  console.log(`Updating claude-nomad v${currentVersion}...`);
  const isWin = process.platform === 'win32';
  try {
    run(isWin ? 'npm.cmd' : 'npm', ['update', '-g', 'claude-nomad'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Now that output is captured rather than inherited, execFileSync buffers
      // it; lift the default 1 MiB ceiling so a noisy-but-successful npm run
      // (deprecation/funding spam) cannot throw ENOBUFS.
      maxBuffer: 64 * 1024 * 1024,
      ...(isWin ? { shell: true } : {}),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === 'ENOENT') {
      throw new NomadFatal('npm not found on PATH; install Node.js/npm and retry.');
    }
    const detail = String(e.stderr ?? '').trim();
    const suffix = detail ? `\n${detail}` : '';
    throw new NomadFatal(`npm update -g claude-nomad failed: ${e.message}${suffix}`);
  }
  const version = readInstalledVersion(run);
  if (version) {
    console.log(`claude-nomad is now at v${version}`);
  } else {
    console.log('Update complete. Run "nomad --version" to confirm the new version.');
  }
}
