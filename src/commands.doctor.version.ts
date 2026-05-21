import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { HOME, UPSTREAM_REPO_SLUG } from './config.ts';

/**
 * Soft, offline-tolerant release-version check appended to `cmdDoctor`. Reads
 * the local `package.json.version`, compares it to the latest release tag on
 * the upstream GitHub repo (cached 1h, 3s curl timeout), and emits one of:
 *   - PASS line when local == latest
 *   - WARN line when local < latest
 *   - informational (no prefix) line when local > latest
 * Every failure path (offline, curl missing, non-2xx, malformed JSON, missing
 * `tag_name`, missing/unreadable package.json) is a SILENT skip; this module
 * never sets `process.exitCode` and never writes to stderr.
 */

/** Absolute path to the cached latest-tag entry. Sits under HOME so tests that
 * override `process.env.HOME` get a sandboxed cache for free. */
const CACHE_PATH = join(HOME, '.cache', 'claude-nomad', 'version-check.json');

/** Cache TTL in milliseconds. Matches GitHub's 1-hour anonymous rate-limit
 * reset window: long enough to collapse `nomad doctor` debugging bursts into a
 * single fetch, short enough that new releases surface within the same day. */
const CACHE_TTL_MS = 60 * 60 * 1000;

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

/** Shape of the on-disk cache entry. Both fields are validated structurally
 * in `loadCache` before use (typeof + finiteness + regex). */
type CacheEntry = { checked_at: number; latest: string };

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
 * Load the cached latest-tag entry. Returns the parsed entry when the file
 * exists, parses cleanly, and matches the expected shape (`checked_at` finite
 * number, `latest` strict-semver string); any failure surfaces as `null` so
 * the caller falls through to `fetchLatestTag`. Treating malformed cache as a
 * miss is the safer default than crashing or surfacing the error.
 */
function loadCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<CacheEntry>;
    if (typeof parsed.checked_at !== 'number' || !Number.isFinite(parsed.checked_at)) {
      return null;
    }
    if (typeof parsed.latest !== 'string' || !STRICT_SEMVER.test(parsed.latest)) {
      return null;
    }
    return { checked_at: parsed.checked_at, latest: parsed.latest };
  } catch {
    return null;
  }
}

/**
 * Persist the latest tag plus a `Date.now()` stamp to the cache file. Errors
 * (read-only filesystem, missing parent dir despite `mkdirSync`, etc.) are
 * swallowed so a cache-write failure never breaks `nomad doctor` output.
 */
function saveCache(latest: string): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ checked_at: Date.now(), latest }));
  } catch {
    // Silent on cache-write failure (locked design): the user-facing
    // diagnostic still emits; the cost is one extra network round-trip on
    // the next invocation.
  }
}

/**
 * Fetch the latest release tag from the upstream GitHub releases API. Uses
 * `execFileSync('curl', ...)` rather than `node:https` because curl honors
 * system proxies, respects the `-m` timeout reliably, and is already a
 * required dependency on every supported host (push uses gitleaks; pull uses
 * git). 3-second timeout, fail-fast on non-2xx (`-f`), silent (`-s`), follow
 * redirects (`-L`). Returns `null` on ANY failure path including a missing
 * `tag_name` field or a tag that fails strict-semver validation after the
 * leading `v` strip. Release tags ship as `v<semver>` per
 * `release-please-config.json`'s `include-v-in-tag: true`.
 */
function fetchLatestTag(): string | null {
  try {
    const url = `https://api.github.com/repos/${UPSTREAM_REPO_SLUG}/releases/latest`;
    const raw = execFileSync(
      'curl',
      ['-fsSL', '-m', '3', '-H', 'Accept: application/vnd.github+json', url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const parsed = JSON.parse(raw) as { tag_name?: unknown };
    if (typeof parsed.tag_name !== 'string') return null;
    const tag = parsed.tag_name.startsWith('v') ? parsed.tag_name.slice(1) : parsed.tag_name;
    if (!STRICT_SEMVER.test(tag)) return null;
    return tag;
  } catch {
    return null;
  }
}

/**
 * Emit a single, non-fatal version diagnostic for `nomad doctor` by comparing the local package.json version to the latest upstream release.
 *
 * Logs one of:
 * - `✓ version: <local> (latest)` when the versions match
 * - `⚠︎ version: <local> -> <latest> (run \`nomad update\`)` when the local version is behind
 * - `ℹ︎ version: <local> (ahead of latest release <latest>)` when the local version is ahead
 *
 * Any failure to read the local version, retrieve or parse the latest release, or use the cache results in no output and does not change `process.exitCode`.
 */
export function reportVersionCheck(section: DoctorSection): void {
  const local = readLocalVersion();
  if (local === null) return;
  // Strip pre-release suffix for the COMPARISON. The display value keeps the
  // full string so e.g. `0.12.0-dev (ahead of latest release 0.11.2)` is
  // readable.
  const localPure = STRICT_SEMVER_PREFIX.exec(local)?.[1] ?? null;
  if (localPure === null) return;

  let latest: string | null = null;
  const cached = loadCache();
  if (cached !== null && Date.now() - cached.checked_at < CACHE_TTL_MS) {
    latest = cached.latest;
  }
  if (latest === null) {
    latest = fetchLatestTag();
    if (latest === null) return;
    saveCache(latest);
  }

  const cmp = compareSemver(localPure, latest);
  if (cmp === 0) {
    addItem(section, `${green(okGlyph)} version: ${local} (latest)`);
  } else if (cmp === -1) {
    addItem(section, `${yellow(warnGlyph)} version: ${local} -> ${latest} (run \`nomad update\`)`);
  } else {
    addItem(section, `${dim(infoGlyph)} version: ${local} (ahead of latest release ${latest})`);
  }
}
