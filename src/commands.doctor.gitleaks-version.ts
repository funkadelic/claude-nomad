import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { green, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { GITLEAKS_PINNED_VERSION, repoHome } from './config.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

/**
 * Soft gitleaks version-drift check appended to the Version section of
 * `nomad doctor`. Parses `gitleaks version` stdout and compares its
 * major.minor against `GITLEAKS_PINNED_VERSION` (the value CI installs),
 * emitting one of:
 *   - `✓ gitleaks: X.Y.Z (matches pinned A.B)` when major.minor agree
 *   - `⚠︎ gitleaks: <local> -> <pin> (CI pins this; local drift may change scan results)`
 *     when major.minor diverge
 * Only major.minor is compared: a patch-only difference is treated as OK,
 * because gitleaks rule/allowlist behavior tracks the minor line, not the
 * patch. Every failure path (gitleaks absent, subprocess error, unparseable
 * or two-segment output) is a SILENT skip; this module never sets
 * `process.exitCode` and never writes to stderr, mirroring the sibling
 * release-version and node-engine checks.
 */

/** Strict three-segment matcher capturing major and minor. Anchored on both
 * ends so a two-segment string like `8.30` does not parse (feeding such a
 * value to a triple-segment comparator would be undecidable). */
const SEMVER_MAJOR_MINOR = /^(\d+)\.(\d+)\.\d+$/;

/** Hard cap on the `gitleaks version` subprocess (matching the gh-actions
 * primitives' `GH_TIMEOUT_MS` convention) so a wedged binary cannot hang the
 * synchronous doctor run; the timeout throws and is swallowed as a silent skip. */
const GITLEAKS_TIMEOUT_MS = 5_000;

/**
 * Capture the `[major, minor]` pair from a strict `X.Y.Z` semver string.
 * Returns `null` when the input does not match a three-segment semver (e.g. a
 * two-segment `8.30`, or non-numeric noise), which the caller treats as a
 * silent skip.
 *
 * @param value - Candidate version string (already trimmed).
 * @returns A `[major, minor]` tuple of bare numeric strings, or `null`.
 */
function majorMinorOf(value: string): [string, string] | null {
  const m = SEMVER_MAJOR_MINOR.exec(value);
  return m === null ? null : [m[1], m[2]];
}

/**
 * Run `gitleaks version` via the injected runner and return the trimmed
 * stdout, or `null` on any throw (missing binary, subprocess failure). Mirrors
 * the `probeGitleaks` invocation form in `push-checks.ts`: argv-array
 * `execFileSync` (no shell), piped stdio, and a conditional
 * `--config <REPO_HOME>/.gitleaks.toml` when that allowlist exists at call
 * time, plus a `GITLEAKS_TIMEOUT_MS` cap so a wedged binary cannot hang the
 * synchronous doctor run. Swallowing the error here is what makes both the
 * absent-gitleaks case and a timeout a silent skip rather than a doctor failure.
 *
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 * @param tomlExists - Injectable allowlist-file existence check; defaults to
 *   `existsSync`. Injected in tests so the `--config` branch is exercised
 *   independent of the host filesystem (REPO_HOME varies per host and in CI).
 * @returns The trimmed `gitleaks version` output, or `null` on any failure.
 */
function readGitleaksVersion(
  run: SpawnSyncFn,
  tomlExists: (path: string) => boolean,
): string | null {
  const tomlPath = join(repoHome(), '.gitleaks.toml');
  const args: string[] = ['version'];
  if (tomlExists(tomlPath)) args.push('--config', tomlPath);
  try {
    return run('gitleaks', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GITLEAKS_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Emit a single, non-fatal gitleaks version-drift diagnostic for
 * `nomad doctor` by comparing the host's `gitleaks version` major.minor to
 * `GITLEAKS_PINNED_VERSION`.
 *
 * Logs one of:
 * - `✓ gitleaks: X.Y.Z (matches pinned A.B)` when the major.minor agree
 *   (including a patch-only difference from the pin)
 * - `⚠︎ gitleaks: <local> -> <pin> (...)` when the major.minor diverge
 *
 * A missing gitleaks binary, a subprocess error, or output that does not match
 * a strict `X.Y.Z` semver results in no output and does not change
 * `process.exitCode`.
 *
 * @param section - The Version section to append the diagnostic line to.
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 * @param tomlExists - Injectable allowlist-file existence check; defaults to
 *   `existsSync`. Mirrors the `run` seam so tests cover the `--config` branch
 *   deterministically.
 */
export function reportGitleaksVersionCheck(
  section: DoctorSection,
  run: SpawnSyncFn = execFileSync,
  tomlExists: (path: string) => boolean = existsSync,
): void {
  const raw = readGitleaksVersion(run, tomlExists);
  if (raw === null) return;
  const local = majorMinorOf(raw);
  if (local === null) return;
  const pin = majorMinorOf(GITLEAKS_PINNED_VERSION);
  // Defensive: GITLEAKS_PINNED_VERSION is a hardcoded strict semver, so this
  // never fires in practice; skip silently rather than risk a false WARN if a
  // future edit ever malforms the constant.
  /* c8 ignore next */
  if (pin === null) return;
  // Compare major.minor ONLY (D-02). Inline numeric compare on the captured
  // segments; do NOT feed a two-segment string to compareSemver (its
  // triple-segment contract returns an undecidable 0).
  const sameMajorMinor = local[0] === pin[0] && local[1] === pin[1];
  if (sameMajorMinor) {
    addItem(section, `${green(okGlyph)} gitleaks: ${raw} (matches pinned ${pin[0]}.${pin[1]})`);
    return;
  }
  addItem(
    section,
    `${yellow(warnGlyph)} gitleaks: ${raw} -> ${GITLEAKS_PINNED_VERSION} (CI pins this; local drift may change scan results)`,
  );
}
