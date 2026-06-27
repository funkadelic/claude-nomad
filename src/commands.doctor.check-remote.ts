import { execFileSync } from 'node:child_process';

import { green, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { repoHome } from './config.ts';
import { validatePathMapShape } from './utils.json.ts';

/**
 * Hard Node-level wall-clock ceiling (ms) applied to each git invocation. Node
 * kills the child on expiry and throws, which collapses to the WARN/skip
 * contract. Mirrors the 3s ceiling used in `http-fetch.ts`.
 */
const GIT_REMOTE_TIMEOUT_MS = 3_000;

/**
 * Read `git show origin/main:path-map.json`, parse the output as JSON, and
 * validate its shape. Returns true when the map is valid, or adds a WARN item
 * and returns false on any failure so the caller can return early.
 */
function readRemotePathMap(sec: DoctorSection, repo: string): boolean {
  let rawJson: string;
  try {
    rawJson = execFileSync('git', ['show', 'origin/main:path-map.json'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_REMOTE_TIMEOUT_MS,
    }).toString();
  } catch {
    addItem(
      sec,
      `${yellow(warnGlyph)} remote check skipped (could not read path-map.json from origin/main)`,
    );
    return false;
  }

  let map: unknown;
  try {
    map = JSON.parse(rawJson);
  } catch {
    addItem(sec, `${yellow(warnGlyph)} remote: path-map.json at origin/main is malformed JSON`);
    return false;
  }

  const shapeError = validatePathMapShape(map);
  if (shapeError !== null) {
    addItem(
      sec,
      `${yellow(warnGlyph)} remote: path-map.json at origin/main has invalid shape: ${shapeError}`,
    );
    return false;
  }

  return true;
}

/**
 * Opt-in `nomad doctor --check-remote` reporter. Runs two bounded git
 * subprocesses against the locally-cached `origin/main` remote-tracking ref:
 * first `git ls-tree --name-only origin/main` to verify `shared/` and
 * `path-map.json` exist at the root, then `git show origin/main:path-map.json`
 * to parse and validate the map shape. Network is only reached if
 * `origin/main` has never been fetched; the Node-level 3s timeout caps any
 * stall regardless. Every failure mode (git absent, ref uncached, timeout,
 * missing shared/, missing or malformed path-map.json, invalid shape) produces
 * a `warnGlyph` WARN/SKIP row and returns without touching `process.exitCode`.
 * Remote structural problems are non-blocking nudges before a pull, not hard
 * failures.
 *
 * @param section - The doctor section to populate.
 */
export function reportCheckRemote(section: DoctorSection): void {
  const repo = repoHome();

  let names: string[];
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'origin/main'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_REMOTE_TIMEOUT_MS,
    })
      .toString()
      .trim();
    names = out.split('\n').filter(Boolean);
  } catch {
    addItem(
      section,
      `${yellow(warnGlyph)} remote check skipped (origin/main unavailable or git error)`,
    );
    return;
  }

  if (!names.includes('shared')) {
    addItem(section, `${yellow(warnGlyph)} remote: shared/ not found in origin/main`);
    return;
  }
  if (!names.includes('path-map.json')) {
    addItem(section, `${yellow(warnGlyph)} remote: path-map.json not found in origin/main`);
    return;
  }

  if (!readRemotePathMap(section, repo)) return;

  addItem(section, `${green(okGlyph)} remote: origin/main has shared/ and a valid path-map.json`);
}
