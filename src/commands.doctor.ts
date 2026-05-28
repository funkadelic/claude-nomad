import {
  reportHostAndPaths,
  reportRepoState,
  reportSharedLinks,
} from './commands.doctor.checks.repo.ts';
import {
  loadAndReportSettings,
  loadBaseSettings,
  reportHostOverrides,
} from './commands.doctor.checks.settings.ts';
import { reportNeverSync, reportPathMap } from './commands.doctor.checks.pathmap.ts';
import {
  reportGitleaksProbe,
  reportGitlinks,
  reportRebaseClean,
  reportRemote,
} from './commands.doctor.checks.repository.ts';
import { reportCheckSchema } from './commands.doctor.check-schema.ts';
import { reportCheckShared } from './commands.doctor.check-shared.ts';
import { reportHooksTargetCheck } from './commands.doctor.checks.hooks.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_HOME, type PathMap } from './config.ts';
import { reportNodeEngineCheck } from './commands.doctor.engine.ts';
import { readJsonSafe, renderDoctor, section } from './commands.doctor.format.ts';
import { reportGitleaksVersionCheck } from './commands.doctor.gitleaks-version.ts';
import { reportMirrorActions } from './commands.doctor.mirror-actions.ts';
import { reportVersionCheck } from './commands.doctor.version.ts';

/**
 * Read-only health check for the nomad install on the current host. Each
 * reporter pushes items into a named section; `renderDoctor` emits the final
 * Claude Code `/doctor`-style tree on stdout via `console.log` (no `ℹ︎`
 * prefix). FAILs in any section bubble up via `process.exitCode = 1` set
 * inside the individual reporters, so a piped
 * `nomad doctor 2>/dev/null` still exposes failures to scripts. Differs from
 * `cmdPull` / `cmdPush` / `resumeCmd`, where FATAL is on stderr.
 *
 * `opts.checkShared` (the `--check-shared` sub-flag) appends a "Shared scan"
 * section that runs the gitleaks preflight over the session transcripts a
 * `nomad push` would stage. It is OFF by default so plain `nomad doctor`
 * stays the fast read-only smoke test (no scan, no temp tree).
 *
 * `opts.checkSchema` (the `--check-schema` sub-flag) appends a "Schema scan"
 * section that fetches the live settings schema and flags local settings.json
 * keys absent from it. Also OFF by default (it needs the network).
 */
export function cmdDoctor(opts: { checkShared?: boolean; checkSchema?: boolean } = {}): void {
  const host = section('Host');
  reportHostAndPaths(host);
  reportRepoState(host);

  const links = section('Shared links');
  // Tolerantly read path-map.json for sharedDirs: doctor is read-only and
  // must not throw on a missing or malformed map. Fall back to { projects: {} }
  // so hooks + static SHARED_LINKS rows still emit on a fresh host.
  const mapPath = join(REPO_HOME, 'path-map.json');
  const rawMap = existsSync(mapPath) ? readJsonSafe<PathMap>(mapPath, mapPath, links) : null;
  const map: PathMap = rawMap ?? { projects: {} };
  reportSharedLinks(links, map);

  const hooksScan = section('Hook targets');
  reportHooksTargetCheck(hooksScan);

  const settings = section('Settings');
  const base = loadBaseSettings(settings);
  const parsedSettings = loadAndReportSettings(settings);
  reportHostOverrides(settings, base, parsedSettings);

  const pathMap = section('Path map');
  reportPathMap(pathMap);

  const neverSync = section('Never-sync');
  reportNeverSync(neverSync);

  const repository = section('Repository');
  const gitleaksReady = reportGitleaksProbe(repository);
  reportGitlinks(repository);
  reportRemote(repository);
  reportRebaseClean(repository);
  reportMirrorActions(repository);

  const version = section('Version Checks');
  reportVersionCheck(version);
  reportNodeEngineCheck(version);
  reportGitleaksVersionCheck(version);

  const sharedScan = section('Shared scan');
  // Reuse the Repository-section readiness probe so reportCheckShared does not
  // re-spawn gitleaks for its own readiness on a --check-shared run; it still
  // probes standalone when called without a prior result. (The Version-section
  // drift check above spawns `gitleaks version` separately, by design.)
  if (opts.checkShared === true) reportCheckShared(sharedScan, gitleaksReady);

  const schemaScan = section('Schema scan');
  if (opts.checkSchema === true) reportCheckSchema(schemaScan);

  renderDoctor([
    version,
    host,
    links,
    hooksScan,
    settings,
    pathMap,
    neverSync,
    repository,
    sharedScan,
    schemaScan,
  ]);
}
