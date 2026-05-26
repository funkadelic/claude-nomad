import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { blue, cyan, dim, failGlyph, green, infoGlyph, okGlyph, red } from './color.ts';
import { HOST, NEVER_SYNC, REPO_HOME, type PathMap } from './config.ts';
import { addItem, readJsonSafe, type DoctorSection } from './commands.doctor.format.ts';
import { encodePath } from './utils.json.ts';

/**
 * Path-map reporters for `cmdDoctor`: the mapped-projects listing, the
 * path-encoding collision scan, and the never-sync visibility line. Each helper
 * appends items to its target `DoctorSection` and signals failure by setting
 * `process.exitCode = 1`. Read-only: FAIL lines stay on stdout.
 */

/** Emits the mapped-projects header for the current host and one line per mapped project. */
function reportMappedProjects(section: DoctorSection, map: PathMap): void {
  const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
  addItem(
    section,
    `${dim(infoGlyph)} mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`,
  );
  for (const [name, hosts] of mapped) {
    addItem(section, `${dim(infoGlyph)} ${name} -> ${blue(hosts[HOST])}`);
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
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    addItem(section, `${red(failGlyph)} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
    return;
  }
  const map = readJsonSafe<PathMap>(mapPath, mapPath, section);
  if (map === null) return;
  // Guard non-object `projects` and per-project non-object `hosts` so the
  // helpers' `hosts[HOST]` / `Object.values(hosts)` cannot throw mid-output
  // and break the tolerant-doctor contract.
  const projects: unknown = (map as { projects?: unknown }).projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    addItem(
      section,
      `${red(failGlyph)} path-map.json invalid schema: "projects" must be an object`,
    );
    process.exitCode = 1;
    return;
  }
  for (const [name, hosts] of Object.entries(projects as Record<string, unknown>)) {
    if (hosts === null || typeof hosts !== 'object' || Array.isArray(hosts)) {
      addItem(
        section,
        `${red(failGlyph)} path-map.json invalid schema: project "${name}" hosts must be an object`,
      );
      process.exitCode = 1;
      return;
    }
    for (const [hostName, mappedPath] of Object.entries(hosts as Record<string, unknown>)) {
      if (typeof mappedPath !== 'string') {
        addItem(
          section,
          `${red(failGlyph)} path-map.json invalid schema: project "${name}" host "${hostName}" path must be a string`,
        );
        process.exitCode = 1;
        return;
      }
    }
  }
  reportMappedProjects(section, map);
  reportPathCollisions(section, map);
}

/** Pushes the comma-joined NEVER_SYNC set for informational visibility. */
export function reportNeverSync(section: DoctorSection): void {
  addItem(section, `${dim(infoGlyph)} never-sync items: ${[...NEVER_SYNC].join(', ')}`);
}
