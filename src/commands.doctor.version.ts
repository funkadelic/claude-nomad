import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { NPM_REGISTRY_LATEST_URL } from './config.ts';
import { fetchUrl } from './http-fetch.ts';

/**
 * Soft, offline-tolerant release-version check appended to `cmdDoctor`. Reads
 * the local `package.json.version`, compares it to the latest published version
 * on the npm registry (3s timeout via curl or wget, fetched fresh each run),
 * and emits one of:
 *   - `✓ claude-nomad: <local> (latest)` when local == latest
 *   - `⚠︎ claude-nomad: <local> -> <latest>` when local < latest
 *   - `ℹ︎ claude-nomad: <local> (ahead of latest release <latest>)` when local > latest
 * Every failure path (offline, curl or wget missing, non-2xx, malformed JSON,
 * missing `version`, missing/unreadable package.json) is a SILENT skip; this
 * module never sets `process.exitCode` and never writes to stderr.
 */

/** Strict-semver regex used to gate both the local version and the latest tag
 * fed into `compareSemver`. Pre-release suffixes like `-dev` are rejected at
 * the regex; downstream callers strip them off before comparing. */
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

/** Capturing variant of `STRICT_SEMVER` used to peel a strict-semver prefix
 * off a pre-release version string (e.g. `0.12.0` out of `0.12.0-dev`). The
 * trailing `(?:[-+]|$)` anchor rejects malformed inputs like `1.2.3foo` or
 * `1.2.3.4` that would otherwise be silently truncated to `1.2.3` and yield
 * a false PASS against an identical `latest`. */
const STRICT_SEMVER_PREFIX = /^(\d+\.\d+\.\d+)(?:[-+]|$)/;

/**
 * Strict triple-segment semver comparison: returns -1 when `a < b`, 0 when
 * equal, 1 when `a > b`. BOTH inputs must match `/^\d+\.\d+\.\d+$/`; any
 * non-strict input causes a 0 return, which the caller treats as "skip the
 * diagnostic" (silent-skip on undecidable comparisons is intentional, mirrors
 * the rest of the version-check codepath that errs on the side of saying
 * nothing). Pure, no side effects.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  if (!STRICT_SEMVER.test(a) || !STRICT_SEMVER.test(b)) return 0;
  const [aMajor, aMinor, aPatch] = a.split('.').map((x) => Number.parseInt(x, 10));
  const [bMajor, bMinor, bPatch] = b.split('.').map((x) => Number.parseInt(x, 10));
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/**
 * Locate and parse the local `package.json` (one directory above this source
 * module). Returns the `version` string when present and non-empty, otherwise
 * `null`. Any throw (missing file, parse error, etc.) becomes a `null` return
 * so the caller silently skips the diagnostic.
 */
function readLocalVersion(): string | null {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the latest published version from the npm registry via the shared HTTP
 * fetcher (curl or wget). The fetcher is optional: a host with neither binary
 * simply skips the version line. 3-second timeout per binary, fail-fast on
 * non-2xx. Returns `null` on ANY failure path (curl or wget missing from PATH,
 * a missing or non-string `version` field, or a version that fails
 * strict-semver validation). The npm registry `version` field is already bare
 * semver (no leading `v` strip needed).
 */
function fetchLatestVersion(): string | null {
  try {
    const raw = fetchUrl(NPM_REGISTRY_LATEST_URL);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== 'string') return null;
    if (!STRICT_SEMVER.test(parsed.version)) return null;
    return parsed.version;
  } catch {
    return null;
  }
}

/**
 * Emit a single, non-fatal version diagnostic for `nomad doctor` by comparing the local package.json version to the latest upstream release.
 *
 * Logs one of:
 * - `✓ claude-nomad: <local> (latest)` when the versions match
 * - `⚠︎ claude-nomad: <local> -> <latest> (run \`nomad update\`)` when the local version is behind
 * - `ℹ︎ claude-nomad: <local> (ahead of latest release <latest>)` when the local version is ahead
 *
 * Any failure to read the local version, or retrieve or parse the latest release, results in no output and does not change `process.exitCode`.
 */
export function reportVersionCheck(section: DoctorSection): void {
  const local = readLocalVersion();
  if (local === null) return;
  // Strip pre-release suffix for the COMPARISON. The display value keeps the
  // full string so e.g. `0.12.0-dev (ahead of latest release 0.11.2)` is
  // readable.
  const localPure = STRICT_SEMVER_PREFIX.exec(local)?.[1] ?? null;
  if (localPure === null) return;

  const latest = fetchLatestVersion();
  if (latest === null) {
    // A silent skip is indistinguishable from "current"; say why the line
    // carries no verdict instead of vanishing. Informational only.
    addItem(
      section,
      `${dim(infoGlyph)} claude-nomad: ${local} (version check skipped: registry unreachable)`,
    );
    return;
  }

  const cmp = compareSemver(localPure, latest);
  if (cmp === 0) {
    addItem(section, `${green(okGlyph)} claude-nomad: ${local} (latest)`);
  } else if (cmp === -1) {
    addItem(
      section,
      `${yellow(warnGlyph)} claude-nomad: ${local} -> ${latest} (run \`nomad update\`)`,
    );
  } else {
    addItem(
      section,
      `${dim(infoGlyph)} claude-nomad: ${local} (ahead of latest release ${latest})`,
    );
  }
}
