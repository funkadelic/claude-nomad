import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { blue, cyan, dim, green, red, yellow } from './color.ts';
// prettier-ignore
import { CLAUDE_HOME, HOST, KNOWN_SETTINGS_KEYS, NEVER_SYNC, REPO_HOME, SHARED_LINKS, type PathMap } from './config.ts';
import { classifyRepoState, reasonForPartial } from './init.ts';
import { findGitlinks } from './push-checks.ts';
import { encodePath, gitStatusPorcelainZ, log, readJson } from './utils.ts';

/**
 * Per-check helpers used by `cmdDoctor`. Each helper writes diagnostics to stdout via `log()` and signals failure by setting `process.exitCode = 1`, mirroring the read-only doctor contract (FAIL lines stay on stdout so a piped `nomad doctor 2>/dev/null` does not lose them).
 */

/**
 * Tolerant JSON reader for `cmdDoctor`. Doctor reads three JSON files
 * (`settings.json`, `settings.base.json`, `path-map.json`); a malformed
 * input must not throw mid-output (user would lose every line below it).
 * Returns `null` on parse failure, logs a FAIL line on stdout (so
 * `2>/dev/null` does not swallow detail), and sets `process.exitCode = 1`
 * so scripts can gate on the result.
 */
function readJsonSafe<T>(path: string, label: string): T | null {
  try {
    return readJson<T>(path);
  } catch (err) {
    log(`FAIL ${label} malformed JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

/** Emits the host identity and the two key path lines (repo and claude-home) with OK/MISSING annotations. */
export function reportHostAndPaths(): void {
  log(`host: ${cyan(HOST)}`);
  log(`repo: ${blue(REPO_HOME)} ${existsSync(REPO_HOME) ? green('OK') : red('MISSING')}`);
  log(
    `claude home: ${blue(CLAUDE_HOME)} ${existsSync(CLAUDE_HOME) ? green('OK') : red('MISSING')}`,
  );
}

/** Emits the repo-state PASS/WARN/FAIL header derived from classifyRepoState; FAIL signals via process.exitCode. */
export function reportRepoState(): void {
  const state = classifyRepoState(REPO_HOME, HOST);
  if (state === 'populated') {
    log(`repo state: ${green('PASS')} populated`);
  } else if (state === 'partial') {
    log(`repo state: ${yellow('WARN')} partial ${reasonForPartial(REPO_HOME, HOST)}`);
  } else {
    log(`repo state: ${red('FAIL')} empty - run 'nomad init' to scaffold`);
    process.exitCode = 1;
  }
}

/** Emits per-entry PASS/WARN/FAIL for each name in SHARED_LINKS; non-symlink blocks sync and FAILs. */
export function reportSharedLinks(): void {
  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      log(`${yellow('WARN')} ${name}: missing`);
      continue;
    }
    if (lstatSync(p).isSymbolicLink()) {
      log(`  ${name}: ${green('PASS')} symlink`);
    } else {
      log(`  ${name}: ${red('FAIL')} NOT a symlink (blocks sync)`);
      process.exitCode = 1;
    }
  }
}

/** Loads shared/settings.base.json, emits FAIL when missing or malformed; returns the parsed object or null. */
export function loadBaseSettings(): Record<string, unknown> | null {
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) {
    log(`${red('FAIL')} shared/settings.base.json missing at ${blue(basePath)}`);
    process.exitCode = 1;
    return null;
  }
  return readJsonSafe<Record<string, unknown>>(basePath, basePath);
}

/** Loads ~/.claude/settings.json when present and emits the schema PASS or unknown-keys WARN; returns the parsed object or null. */
export function loadAndReportSettings(): Record<string, unknown> | null {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  const settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath);
  if (settings === null) return null;
  const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
  if (unknownKeys.length > 0) {
    log(
      `${yellow('WARN')} settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')}`,
    );
  } else {
    log(`${green('PASS')} settings.json schema: known keys only`);
  }
  return settings;
}

/** Emits the host-override status: PASS, FAIL on drift without a host file (with candidate list), or PASS path when the host file parses. */
export function reportHostOverrides(
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
    if (readJsonSafe<Record<string, unknown>>(hostFile, hostFile) !== null) {
      log(`host overrides: ${blue(hostFile)}`);
    }
  } else if (drift.length > 0) {
    log(
      `${red('FAIL')} no hosts/${HOST}.json AND settings.json has unbased keys ${JSON.stringify(drift)}`,
    );
    const hostsDir = join(REPO_HOME, 'hosts');
    if (existsSync(hostsDir)) {
      const cands = readdirSync(hostsDir).filter((f) => f.endsWith('.json'));
      if (cands.length > 0) log(`  candidates: ${cands.join(', ')}`);
    }
    process.exitCode = 1;
  } else {
    log(`${green('PASS')} host overrides: none (base-only is fine, no settings drift)`);
  }
}

/** Lists mapped projects for the current host and FAILs on path-encoding collisions across hosts; FAILs when path-map.json is missing. */
export function reportPathMap(): void {
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (existsSync(mapPath)) {
    const map = readJsonSafe<PathMap>(mapPath, mapPath);
    if (map !== null) {
      const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
      log(`mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
      for (const [name, hosts] of mapped) log(`  ${name} -> ${blue(hosts[HOST])}`);

      const seen = new Map<string, string>();
      let collisionCount = 0;
      for (const hosts of Object.values(map.projects)) {
        for (const abspath of Object.values(hosts)) {
          if (!abspath || abspath === 'TBD') continue;
          const encoded = encodePath(abspath);
          const prior = seen.get(encoded);
          if (prior !== undefined && prior !== abspath) {
            log(
              `${red('FAIL')} path-encoding collision: ${prior} and ${abspath} both encode to ${encoded}`,
            );
            collisionCount++;
          } else {
            seen.set(encoded, abspath);
          }
        }
      }
      if (collisionCount > 0) {
        process.exitCode = 1;
      } else {
        log(`${green('PASS')} path-encoding: no collisions`);
      }
    }
  } else {
    log(`${red('FAIL')} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
  }
}

/** Emits the comma-joined NEVER_SYNC set for informational visibility. */
export function reportNeverSync(): void {
  log(`never-sync items: ${[...NEVER_SYNC].join(', ')}`);
}

/** Probes for gitleaks on PATH; PASS with version or FAIL with ENOENT vs other error distinction. */
export function reportGitleaksProbe(): void {
  try {
    const v = execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    log(`${green('PASS')} gitleaks: ${dim(v)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`${red('FAIL')} gitleaks: not on PATH (required for nomad push)`);
    } else {
      log(`${red('FAIL')} gitleaks: probe failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

/** Walks shared/ for nested .git gitlinks; FAIL per gitlink found, PASS when none. */
export function reportGitlinks(): void {
  const sharedDir = join(REPO_HOME, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(REPO_HOME, p);
      log(
        `${red('FAIL')} gitlink: ${blue(rel)} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
      );
    }
    if (gitlinks.length > 0) {
      process.exitCode = 1;
    } else {
      log(`${green('PASS')} gitlink scan: no nested .git in shared/`);
    }
  }
}

/** Emits the `git remote get-url origin` line or a `not configured` informational line. */
export function reportRemote(): void {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    log(`remote origin: ${cyan(url)}`);
  } catch {
    log('remote origin: not configured');
  }
}

/** WARNs when ~/claude-nomad/ has uncommitted changes (autostash territory for push). */
export function reportRebaseClean(): void {
  try {
    const status = gitStatusPorcelainZ(REPO_HOME);
    if (status.length > 0) {
      log(
        `${yellow('WARN')} ${blue('~/claude-nomad/')} has uncommitted changes (nomad push will --autostash these)`,
      );
    }
  } catch {
    // Repo missing .git is already surfaced by the repo: MISSING line above.
  }
}
