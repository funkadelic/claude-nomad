import { execFileSync } from 'node:child_process';

import { green, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

/**
 * Optional-dependency presence reporter for `nomad doctor`. Probes for `gh`
 * and `curl` (both optional CLIs used by nomad features) and emits one row
 * per binary in the Version Checks section:
 *   - present with parsed version: `okGlyph gh: X.Y.Z`
 *   - present but version unparseable: `okGlyph gh: present`
 *   - not installed (ENOENT): `warnGlyph gh: not installed (optional; ...)`
 *
 * This reporter MUST NOT set `process.exitCode`: absent optional deps are
 * informational only (D-02). Both probes always run unconditionally.
 */

/** Regex to extract the first X.Y.Z version token from a string. */
const VERSION_TOKEN = /(\d+\.\d+\.\d+)/;

/**
 * Extract the first X.Y.Z-shaped version token from a string.
 *
 * @param line - A single line of --version output (already trimmed).
 * @returns The first version token, or `null` if none found.
 */
function parseFirstVersion(line: string): string | null {
  const m = VERSION_TOKEN.exec(line);
  return m ? m[1] : null;
}

/** Discriminated union for binary probe results. */
type DepProbeResult = { status: 'present'; version: string | null } | { status: 'not-installed' };

/**
 * Probe a binary by running `bin --version` and parsing the first output line.
 * Returns a DepProbeResult: present (with optional version token) or
 * not-installed (ENOENT). Non-ENOENT errors are treated as present with no
 * version (D-03: "never FAIL on unexpected --version output").
 *
 * @param bin - The binary name to probe (e.g. `gh` or `curl`).
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
function probeOptionalDep(bin: string, run: SpawnSyncFn): DepProbeResult {
  try {
    const firstLine = run(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .split('\n')[0]
      .trim();
    const version = parseFirstVersion(firstLine);
    return { status: 'present', version };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'not-installed' };
    }
    // Non-ENOENT: binary may exist but --version misbehaved; report as present.
    return { status: 'present', version: null };
  }
}

/**
 * Emit presence rows for the optional `gh` and `curl` CLIs into the given
 * doctor section. Each row shows the binary's install status and version (if
 * parseable). Absent binaries emit a WARN naming the features they enable.
 * Never sets `process.exitCode` (D-02): both deps are optional.
 *
 * @param section - The Version Checks section to append rows to.
 * @param run - Injectable subprocess runner; defaults to `execFileSync`.
 */
export function reportOptionalDeps(section: DoctorSection, run: SpawnSyncFn = execFileSync): void {
  const gh = probeOptionalDep('gh', run);
  if (gh.status === 'present') {
    addItem(section, `${green(okGlyph)} gh: ${gh.version ?? 'present'}`);
  } else {
    addItem(
      section,
      `${yellow(warnGlyph)} gh: not installed (optional; needed for nomad init Actions auto-disable + mirror-Actions drift check)`,
    );
  }

  const curl = probeOptionalDep('curl', run);
  if (curl.status === 'present') {
    addItem(section, `${green(okGlyph)} curl: ${curl.version ?? 'present'}`);
  } else {
    addItem(
      section,
      `${yellow(warnGlyph)} curl: not installed (optional; needed for release-version staleness check + nomad doctor --check-schema)`,
    );
  }
}
