import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { blue, cyan, dim, green, red, yellow } from './color.ts';
// prettier-ignore
import { CLAUDE_HOME, HOST, KNOWN_SETTINGS_KEYS, NEVER_SYNC, REPO_HOME, SHARED_LINKS, type PathMap } from './config.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { classifyRepoState, reasonForPartial } from './init.ts';
import { findGitlinks } from './push-checks.ts';
import { encodePath, gitStatusPorcelainZ, readJson } from './utils.ts';

/**
 * Per-check helpers used by `cmdDoctor`. Each helper appends one or more items
 * to its target `DoctorSection` (via `addItem`) and signals failure by setting
 * `process.exitCode = 1`. Items go to stdout at render time through
 * `renderDoctor` in `commands.doctor.format`; nothing here writes to stderr
 * (read-only doctor contract: FAIL lines stay on stdout so a piped
 * `nomad doctor 2>/dev/null` does not lose them).
 */

/**
 * Tolerant JSON reader for `cmdDoctor`. Doctor reads three JSON files
 * (`settings.json`, `settings.base.json`, `path-map.json`); a malformed
 * input must not throw mid-output (user would lose every line below it).
 * Returns `null` on parse failure, records a FAIL item in the supplied
 * section, and sets `process.exitCode = 1` so scripts can gate on the result.
 */
function readJsonSafe<T>(path: string, label: string, section: DoctorSection): T | null {
  try {
    return readJson<T>(path);
  } catch (err) {
    addItem(section, `${red('FAIL')} ${label} malformed JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

/** Pushes the host identity and the two key path lines (repo and claude-home) with OK/MISSING annotations. */
export function reportHostAndPaths(section: DoctorSection): void {
  addItem(section, `host: ${cyan(HOST)}`);
  addItem(
    section,
    `repo: ${blue(REPO_HOME)} ${existsSync(REPO_HOME) ? green('OK') : red('MISSING')}`,
  );
  addItem(
    section,
    `claude home: ${blue(CLAUDE_HOME)} ${existsSync(CLAUDE_HOME) ? green('OK') : red('MISSING')}`,
  );
}

/** Pushes the repo-state PASS/WARN/FAIL header derived from classifyRepoState; FAIL signals via process.exitCode. */
export function reportRepoState(section: DoctorSection): void {
  const state = classifyRepoState(REPO_HOME, HOST);
  if (state === 'populated') {
    addItem(section, `repo state: ${green('PASS')} populated`);
  } else if (state === 'partial') {
    addItem(section, `repo state: ${yellow('WARN')} partial ${reasonForPartial(REPO_HOME, HOST)}`);
  } else {
    addItem(section, `repo state: ${red('FAIL')} empty - run 'nomad init' to scaffold`);
    process.exitCode = 1;
  }
}

/** Pushes per-entry PASS/WARN/FAIL for each name in SHARED_LINKS; non-symlink blocks sync and FAILs. */
export function reportSharedLinks(section: DoctorSection): void {
  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      addItem(section, `${yellow('WARN')} ${name}: missing`);
      continue;
    }
    if (lstatSync(p).isSymbolicLink()) {
      addItem(section, `${name}: ${green('PASS')} symlink`);
    } else {
      addItem(section, `${name}: ${red('FAIL')} NOT a symlink (blocks sync)`);
      process.exitCode = 1;
    }
  }
}

/** Loads shared/settings.base.json; on missing or malformed, records a FAIL item in the supplied section. Returns the parsed object or null. */
export function loadBaseSettings(section: DoctorSection): Record<string, unknown> | null {
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) {
    addItem(section, `${red('FAIL')} shared/settings.base.json missing at ${blue(basePath)}`);
    process.exitCode = 1;
    return null;
  }
  return readJsonSafe<Record<string, unknown>>(basePath, basePath, section);
}

/** Loads ~/.claude/settings.json when present and pushes the schema PASS or unknown-keys WARN; returns the parsed object or null. */
export function loadAndReportSettings(section: DoctorSection): Record<string, unknown> | null {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  const settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath, section);
  if (settings === null) return null;
  const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
  if (unknownKeys.length > 0) {
    addItem(
      section,
      `${yellow('WARN')} settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')}`,
    );
  } else {
    addItem(section, `${green('PASS')} settings.json schema: known keys only`);
  }
  return settings;
}

/** Pushes the host-override status: PASS, FAIL on drift without a host file (with candidate list), or PASS path when the host file parses. */
export function reportHostOverrides(
  section: DoctorSection,
  base: Record<string, unknown> | null,
  settings: Record<string, unknown> | null,
): void {
  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  let drift: string[] = [];
  if (base !== null && settings !== null) {
    const baseKeys = new Set(Object.keys(base));
    drift = Object.keys(settings).filter((k) => !baseKeys.has(k));
  }
  if (existsSync(hostFile)) {
    if (readJsonSafe<Record<string, unknown>>(hostFile, hostFile, section) !== null) {
      addItem(section, `host overrides: ${blue(hostFile)}`);
    }
  } else if (drift.length > 0) {
    addItem(
      section,
      `${red('FAIL')} no hosts/${HOST}.json AND settings.json has unbased keys ${JSON.stringify(drift)}`,
    );
    const hostsDir = join(REPO_HOME, 'hosts');
    if (existsSync(hostsDir)) {
      const cands = readdirSync(hostsDir).filter((f) => f.endsWith('.json'));
      if (cands.length > 0) addItem(section, `candidates: ${cands.join(', ')}`);
    }
    process.exitCode = 1;
  } else {
    addItem(
      section,
      `${green('PASS')} host overrides: none (base-only is fine, no settings drift)`,
    );
  }
}

/** Emits the mapped-projects header for the current host and one line per mapped project. */
function reportMappedProjects(section: DoctorSection, map: PathMap): void {
  const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
  addItem(section, `mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
  for (const [name, hosts] of mapped) addItem(section, `${name} -> ${blue(hosts[HOST])}`);
}

/** Scans every host of every project for encodePath collisions; FAILs per collision, PASSes when clean. */
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
          `${red('FAIL')} path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`,
        );
        collisionCount++;
      } else {
        seen.set(encoded, abspath);
      }
    }
  }
  if (collisionCount > 0) process.exitCode = 1;
  else addItem(section, `${green('PASS')} path-encoding: no collisions`);
}

/** Pushes mapped projects for the current host and FAILs on path-encoding collisions across hosts; FAILs when path-map.json is missing. */
export function reportPathMap(section: DoctorSection): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) {
    addItem(section, `${red('FAIL')} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
    return;
  }
  const map = readJsonSafe<PathMap>(mapPath, mapPath, section);
  if (map === null) return;
  // Guard non-object `projects` so Object.entries does not throw mid-output and break the tolerant-doctor contract.
  const projects: unknown = (map as { projects?: unknown }).projects;
  if (projects === null || typeof projects !== 'object') {
    addItem(section, `${red('FAIL')} path-map.json invalid schema: "projects" must be an object`);
    process.exitCode = 1;
    return;
  }
  reportMappedProjects(section, map);
  reportPathCollisions(section, map);
}

/** Pushes the comma-joined NEVER_SYNC set for informational visibility. */
export function reportNeverSync(section: DoctorSection): void {
  addItem(section, `never-sync items: ${[...NEVER_SYNC].join(', ')}`);
}

/** Probes for gitleaks on PATH; PASS with version or FAIL with ENOENT vs other error distinction. */
export function reportGitleaksProbe(section: DoctorSection): void {
  try {
    const v = execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    addItem(section, `${green('PASS')} gitleaks: ${dim(v)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      addItem(section, `${red('FAIL')} gitleaks: not on PATH (required for nomad push)`);
    } else {
      addItem(section, `${red('FAIL')} gitleaks: probe failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

/** Walks shared/ for nested .git gitlinks; FAIL per gitlink found, PASS when none. */
export function reportGitlinks(section: DoctorSection): void {
  const sharedDir = join(REPO_HOME, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(REPO_HOME, p);
      addItem(
        section,
        `${red('FAIL')} gitlink: ${blue(rel)} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
      );
    }
    if (gitlinks.length > 0) {
      process.exitCode = 1;
    } else {
      addItem(section, `${green('PASS')} gitlink scan: no nested .git in shared/`);
    }
  }
}

/** Pushes the `git remote get-url origin` line or a `not configured` informational line. */
export function reportRemote(section: DoctorSection): void {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    addItem(section, `remote origin: ${cyan(url)}`);
  } catch {
    addItem(section, 'remote origin: not configured');
  }
}

/** WARNs when ~/claude-nomad/ has uncommitted changes (autostash territory for push). */
export function reportRebaseClean(section: DoctorSection): void {
  try {
    const status = gitStatusPorcelainZ(REPO_HOME);
    if (status.length > 0) {
      addItem(
        section,
        `${yellow('WARN')} ${blue('~/claude-nomad/')} has uncommitted changes (nomad push will --autostash these)`,
      );
    }
  } catch {
    // Repo missing .git is already surfaced by the repo: MISSING line above.
  }
}
