import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { blue, cyan, dim, green, red, yellow } from './color.ts';
// prettier-ignore
import { CLAUDE_HOME, HOST, KNOWN_SETTINGS_KEYS, NEVER_SYNC, REPO_HOME, SHARED_LINKS, type PathMap } from './config.ts';
import { findGitlinks } from './push-checks.ts';
import { encodePath, gitStatusPorcelainZ, log, readJson } from './utils.ts';

/**
 * Tolerant JSON reader for `cmdDoctor`. Doctor reads three JSON files
 * (`settings.json`, `settings.base.json`, `path-map.json`) and any
 * malformed input must not throw an uncaught `SyntaxError` mid-output;
 * users would otherwise get a stack trace instead of a FAIL line and the
 * remainder of the diagnostic would never run. Returns `null` on parse
 * failure, logs the FAIL line on the same stream as the rest of doctor's
 * output (stdout, so `2>/dev/null` does not swallow failure detail), and
 * sets `process.exitCode = 1` so scripts can gate on the result.
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

/**
 * Read-only health check for the nomad install on the current host. Reports
 * host identity, repo presence, shared-link health, settings.json schema
 * sanity, host-override status, path-map collisions, and the never-sync
 * list.
 *
 * Doctor intentionally emits ALL diagnostics (PASS/WARN/FAIL) on stdout via
 * `log()` rather than splitting WARN/FAIL to stderr. The intent is that
 * users see the full diagnostic cohesively; piping `nomad doctor 2>/dev/null`
 * must NOT lose FAIL lines. This differs from `cmdPull` / `cmdPush` /
 * `resumeCmd`, where FATAL is on stderr because those callers want clean
 * stdout. Doctor signals failure to scripts via `process.exitCode` instead.
 */
export function cmdDoctor(): void {
  log(`host: ${cyan(HOST)}`);
  log(`repo: ${blue(REPO_HOME)} ${existsSync(REPO_HOME) ? green('OK') : red('MISSING')}`);
  log(
    `claude home: ${blue(CLAUDE_HOME)} ${existsSync(CLAUDE_HOME) ? green('OK') : red('MISSING')}`,
  );

  for (const name of SHARED_LINKS) {
    const p = join(CLAUDE_HOME, name);
    if (!existsSync(p)) {
      log(`  ${name}: missing`);
      continue;
    }
    log(
      `  ${name}: ${lstatSync(p).isSymbolicLink() ? green('symlink OK') : red('NOT a symlink (blocks sync)')}`,
    );
  }

  // Preemptively report missing OR malformed shared/settings.base.json (pull
  // would die() on either). Parse unconditionally when present so a fresh host
  // (no settings.json yet) still catches a broken base before the first pull.
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  let base: Record<string, unknown> | null = null;
  if (!existsSync(basePath)) {
    log(`${red('FAIL')} shared/settings.base.json missing at ${blue(basePath)}`);
    process.exitCode = 1;
  } else {
    base = readJsonSafe<Record<string, unknown>>(basePath, basePath);
  }

  // Scan settings.json top-level keys against the schema baseline. WARN on
  // unknown keys (forward-compatible by default; no exitCode change).
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  let settings: Record<string, unknown> | null = null;
  if (existsSync(settingsPath)) {
    settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath);
    if (settings !== null) {
      const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
      if (unknownKeys.length > 0) {
        log(
          `${yellow('WARN')} settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')}`,
        );
      } else {
        log('settings.json schema: known keys only');
      }
    }
  }

  // Host-override-missing FAIL (complements links.ts pull-side WARN). Drift
  // calculation only runs when both base and settings parsed successfully.
  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  let drift: string[] = [];
  if (base !== null && settings !== null) {
    const baseKeys = new Set(Object.keys(base));
    drift = Object.keys(settings).filter((k) => !baseKeys.has(k));
  }
  if (existsSync(hostFile)) {
    // Parse hostFile to surface malformed JSON before pull's deep-merge would
    // fail on it; readJsonSafe FAILs and sets exitCode=1 on parse error.
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
    log('host overrides: none (base-only is fine, no settings drift)');
  }

  const mapPath = join(REPO_HOME, 'path-map.json');
  if (existsSync(mapPath)) {
    const map = readJsonSafe<PathMap>(mapPath, mapPath);
    if (map !== null) {
      const mapped = Object.entries(map.projects).filter(([, hosts]) => hosts[HOST]);
      log(`mapped projects for ${cyan(HOST)}: ${dim(String(mapped.length))}`);
      for (const [name, hosts] of mapped) log(`  ${name} -> ${blue(hosts[HOST])}`);

      // Encode-collision scan across all hosts; FAIL because remap data loss is silent.
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
      if (collisionCount > 0) process.exitCode = 1;
    }
  } else {
    log(`${red('FAIL')} path-map.json missing at ${blue(mapPath)}`);
    process.exitCode = 1;
  }

  log(`never-sync items: ${[...NEVER_SYNC].join(', ')}`);

  // Gitleaks presence probe (read-only; logs PASS/FAIL, never throws).
  try {
    const v = execFileSync('gitleaks', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    log(`gitleaks: ${dim(v)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`${red('FAIL')} gitleaks: not on PATH (required for nomad push)`);
    } else {
      log(`${red('FAIL')} gitleaks: probe failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }

  // Gitlink scan of shared/ (read-only mirror of cmdPush's walk).
  const sharedDir = join(REPO_HOME, 'shared');
  if (existsSync(sharedDir)) {
    const gitlinks = findGitlinks(sharedDir);
    for (const p of gitlinks) {
      const rel = relative(REPO_HOME, p);
      log(
        `${red('FAIL')} gitlink: ${blue(rel)} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`,
      );
    }
    if (gitlinks.length > 0) process.exitCode = 1;
  }

  // Remote URL informational (no PASS/FAIL prefix).
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

  // Rebase clean-tree WARN; surfaces the autostash behavior on push.
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
