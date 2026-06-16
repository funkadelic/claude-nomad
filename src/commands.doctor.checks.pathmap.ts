import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { blue, cyan, dim, failGlyph, green, infoGlyph, okGlyph, red } from './color.ts';
import { claudeHome, HOST, NEVER_SYNC, repoHome, type PathMap } from './config.ts';
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
