import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  blue,
  cyan,
  dim,
  failGlyph,
  green,
  infoGlyph,
  okGlyph,
  red,
  warnGlyph,
  yellow,
} from './color.ts';
import { claudeHome, HOST, NEVER_SYNC, repoHome, type PathMap } from './config.ts';
import { validateSharedDirEntry } from './config.sharedDirs.guard.ts';
import {
  addChildItem,
  addItem,
  readJsonSafe,
  type DoctorSection,
} from './commands.doctor.format.ts';
import { encodePath, validatePathMapShape } from './utils.json.ts';

/**
 * Path-map reporters for `cmdDoctor`: the mapped-projects listing, the
 * path-encoding collision scan, and the never-sync visibility line. Each helper
 * appends items to its target `DoctorSection` and signals failure by setting
 * `process.exitCode = 1`. Read-only: FAIL lines stay on stdout.
 */

/** Emits the mapped-projects header for the current host and one nested child row per mapped project. */
function reportMappedProjects(section: DoctorSection, map: PathMap): void {
  const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
  addItem(section, `Mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
  for (const [name, hosts] of mapped) {
    addChildItem(section, `${name} -> ${blue(hosts[HOST])}`);
  }
}

/**
 * Emits the unmapped-projects header and one nested child row per local
 * `~/.claude/projects/<encoded>/` dir with no path-map entry for this host.
 * These are what `nomad push` reports as "N unmapped" (left alone in both
 * directions); listing them here closes the loop on the push summary's
 * "run nomad doctor to list" hint. Silent when every local dir is mapped or
 * the local projects dir does not exist.
 */
function reportUnmappedProjects(section: DoctorSection, map: PathMap): void {
  const localProjects = join(claudeHome(), 'projects');
  if (!existsSync(localProjects)) return;
  // Tolerant-doctor contract: an unreadable projects dir (permissions) skips
  // this informational listing instead of throwing mid-output.
  let localDirs: string[];
  try {
    localDirs = readdirSync(localProjects);
  } catch {
    return;
  }
  const mappedEncodings = new Set(
    Object.values(map.projects)
      .map((hosts) => hosts[HOST])
      .filter(Boolean)
      .map((abspath) => encodePath(abspath)),
  );
  const unmapped = localDirs.filter((dir) => !mappedEncodings.has(dir));
  if (unmapped.length === 0) return;
  addItem(section, `Unmapped local projects (not synced): ${dim(String(unmapped.length))}`);
  for (const dir of unmapped) {
    addChildItem(section, dim(dir));
  }
}

/**
 * Emits a WARN row for each path-map entry where the current host's local path
 * does not exist on disk. Skips entries for other hosts (legitimately absent on
 * this machine), TBD placeholders, and empty strings. Does not set
 * process.exitCode: a project may legitimately be cloned on only some hosts, so
 * a missing path is a nudge before a remap fails, not a hard failure.
 */
function reportCurrentHostPathsMissing(section: DoctorSection, map: PathMap): void {
  for (const [name, hosts] of Object.entries(map.projects)) {
    const abspath = hosts[HOST];
    if (!abspath || abspath === 'TBD') continue;
    if (!existsSync(abspath)) {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: ${name} local path missing on ${HOST}: ${blue(abspath)}`,
      );
    }
  }
}

/**
 * Lists the direct entry names under `shared/` in the repo working tree, for
 * matching a rejected `sharedDirs` entry against a leftover copy already on
 * disk. Wrapped in try/catch so an absent, unreadable, or non-directory
 * `shared/` degrades to an empty set instead of aborting the doctor run; the
 * caller's rejection rows are unaffected by this failure.
 *
 * @returns The set of names directly under `shared/`, or an empty set on any
 *   read failure.
 */
function sharedDirNames(): Set<string> {
  try {
    return new Set(readdirSync(join(repoHome(), 'shared')));
  } catch {
    return new Set();
  }
}

/**
 * Report whether `~/.claude/<entry>` is currently a symlink, which is the state
 * an older, looser guard leaves behind after `nomad adopt` moved that name into
 * `shared/`. Follows the tolerant-doctor contract: an absent path, an
 * unreadable parent, or a path component that is not a directory all degrade to
 * `false` instead of throwing mid-output.
 *
 * @param entry - The rejected `sharedDirs` name to probe under `~/.claude/`.
 * @returns `true` only when a symlink is present at `~/.claude/<entry>`.
 */
function isLocalSymlink(entry: string): boolean {
  try {
    const stat = lstatSync(join(claudeHome(), entry), { throwIfNoEntry: false });
    return stat?.isSymbolicLink() === true;
  } catch {
    return false;
  }
}

/**
 * Emits a top-level WARN row for every rejected `sharedDirs` entry in
 * `path-map.json`, naming the entry and the specific reason
 * {@link validateSharedDirEntry} gave. Rows are pushed as top-level items,
 * never as nested children: `compactSections` keeps a row by its WARN glyph
 * alone, so a child row survives into the compact view while the passing
 * parent it belonged under does not. `renderChildLine` then attaches its
 * connector to whatever row happens to precede it, and the rejection reads as
 * subordinate to an unrelated entry. Never sets `process.exitCode`, since the
 * condition already fails closed at the push gate and this row is
 * informational, not a failure.
 *
 * For any rejected entry this host may still have materialized, also emits a
 * remediation row. A live symlink at `~/.claude/<entry>` points INTO
 * `shared/<entry>`, so that row leads with copying the content out and only
 * then removing both: telling the user to delete the repo-side path on its own
 * would destroy the only copy and leave a dangling link behind. With no such
 * symlink, a leftover directly under `shared/` (from before this guard
 * existed) gets the plain remove-it-by-hand row instead. Nomad never deletes
 * either one.
 *
 * Tolerates a malformed `sharedDirs` (a non-array, or members that are not
 * strings): reading `map.sharedDirs` via `Array.isArray` rather than the
 * `?? []` fallthrough used elsewhere in this file, because a non-array value
 * would otherwise throw on iteration and abort the whole doctor run.
 *
 * @param section - The doctor "Path map" section to append rows to.
 * @param map - Parsed `path-map.json` content.
 */
function reportRejectedSharedDirs(section: DoctorSection, map: PathMap): void {
  const entries: unknown[] = Array.isArray(map.sharedDirs) ? map.sharedDirs : [];
  const rejected: unknown[] = [];
  for (const entry of entries) {
    const rejection = validateSharedDirEntry(entry);
    if (rejection === null) continue;
    rejected.push(entry);
    addItem(
      section,
      `${yellow(warnGlyph)} path-map: sharedDirs entry ${JSON.stringify(entry)} rejected: ${rejection.message}; skipping`,
    );
  }
  if (rejected.length === 0) return;
  const existing = sharedDirNames();
  for (const entry of rejected) {
    if (typeof entry !== 'string') continue;
    if (isLocalSymlink(entry)) {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: ~/.claude/${entry} is a symlink into shared/${entry}; ` +
          `copy the content out first (cp -RL), then remove both. nomad will not do it for you`,
      );
    } else if (existing.has(entry)) {
      addItem(
        section,
        `${yellow(warnGlyph)} path-map: shared/${entry} exists in the repo working tree; remove it by hand, nomad will not delete it`,
      );
    }
  }
}

/** Scans every host of every project for encodePath collisions; emits failGlyph per collision (sets exitCode=1), okGlyph when clean. */
function reportPathCollisions(section: DoctorSection, map: PathMap): void {
  const seen = new Map<string, string>();
  let collisionCount = 0;
  for (const hosts of Object.values(map.projects)) {
    for (const abspath of Object.values(hosts)) {
      if (!abspath || abspath === 'TBD') continue;
      const encoded = encodePath(abspath);
      const prior = seen.get(encoded);
      if (prior !== undefined && prior !== abspath) {
        addItem(
          section,
          `${red(failGlyph)} path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`,
        );
        collisionCount++;
      } else {
        seen.set(encoded, abspath);
      }
    }
  }
  if (collisionCount > 0) process.exitCode = 1;
  else addItem(section, `${green(okGlyph)} path-encoding: no collisions`);
}

/** Pushes mapped projects for the current host and FAILs on path-encoding collisions across hosts; FAILs when path-map.json is missing. */
export function reportPathMap(section: DoctorSection): void {
  const mapPath = join(repoHome(), 'path-map.json');
  if (!existsSync(mapPath)) {
    addItem(section, `${red(failGlyph)} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
    return;
  }
  const map = readJsonSafe<PathMap>(mapPath, mapPath, section);
  if (map === null) return;
  // Guard non-object `projects` and per-project non-object `hosts` so the
  // helpers' `hosts[HOST]` / `Object.values(hosts)` cannot throw mid-output and
  // break the tolerant-doctor contract. Shares the shape walk with `readPathMap`
  // and `resume.ts` via `validatePathMapShape` for one uniform error vocabulary.
  const shapeError = validatePathMapShape(map);
  if (shapeError !== null) {
    addItem(section, `${red(failGlyph)} ${shapeError}`);
    process.exitCode = 1;
    return;
  }
  reportMappedProjects(section, map);
  reportCurrentHostPathsMissing(section, map);
  reportRejectedSharedDirs(section, map);
  reportUnmappedProjects(section, map);
  reportPathCollisions(section, map);
}

/** Pushes a one-line NEVER_SYNC count with a docs pointer; the full static list is config, not diagnosis. */
export function reportNeverSync(section: DoctorSection): void {
  addItem(
    section,
    `${dim(infoGlyph)} never-sync items: ${NEVER_SYNC.size} protected ${dim(
      '(https://funkadelic.github.io/claude-nomad/how-it-works/)',
    )}`,
  );
}
