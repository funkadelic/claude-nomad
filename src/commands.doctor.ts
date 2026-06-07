import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  reportRebaseState,
  reportRemote,
} from './commands.doctor.checks.repository.ts';
import { reportBackupsCheck } from './commands.doctor.checks.backups.ts';
import { reportCheckSchema } from './commands.doctor.check-schema.ts';
import { reportCheckShared } from './commands.doctor.check-shared.ts';
import { reportHookScopeCheck } from './commands.doctor.checks.hooks.scope.ts';
import { reportHooksTargetCheck } from './commands.doctor.checks.hooks.ts';
import { reportPreserveSymlinksCheck } from './commands.doctor.checks.hooks.preserve-symlinks.ts';
import { reportSettingsDriftCheck } from './commands.doctor.checks.settings-drift.ts';
import { repoHome, type PathMap } from './config.ts';
import { reportNodeEngineCheck } from './commands.doctor.engine.ts';
import {
  readJsonSafe,
  renderDoctor,
  section,
  type DoctorSection,
} from './commands.doctor.format.ts';
import { startSpinner as realStartSpinner, type SpinnerHandle } from './spinner.ts';
import { reportGitleaksVersionCheck } from './commands.doctor.gitleaks-version.ts';
import { reportOptionalDeps } from './commands.doctor.checks.deps.ts';
import { reportActionsDrift } from './commands.doctor.actions-drift.ts';
import { reportVersionCheck } from './commands.doctor.version.ts';
import { buildVerdictSection } from './commands.doctor.verdict.ts';

/**
 * Run every doctor reporter and assemble the final ordered section array
 * (body sections followed by the verdict). All check branching lives here so
 * `cmdDoctor` stays linear under the cognitive-complexity gate.
 */
function gatherDoctorSections(opts: {
  checkShared?: boolean;
  checkSchema?: boolean;
}): DoctorSection[] {
  const host = section('Environment');
  reportHostAndPaths(host);
  reportRepoState(host);

  const links = section('Shared links');
  // Tolerantly read path-map.json for sharedDirs: doctor is read-only and
  // must not throw on a missing or malformed map. Fall back to { projects: {} }
  // so hooks + static SHARED_LINKS rows still emit on a fresh host.
  const mapPath = join(repoHome(), 'path-map.json');
  const rawMap = existsSync(mapPath) ? readJsonSafe<PathMap>(mapPath, mapPath, links) : null;
  const map: PathMap = rawMap ?? { projects: {} };
  reportSharedLinks(links, map);

  const hooksScan = section('Hook targets');
  reportHooksTargetCheck(hooksScan);
  reportHookScopeCheck(hooksScan);
  reportPreserveSymlinksCheck(hooksScan);

  const settings = section('Settings');
  const base = loadBaseSettings(settings);
  const parsedSettings = loadAndReportSettings(settings);
  reportHostOverrides(settings, base, parsedSettings);
  reportSettingsDriftCheck(settings);

  const pathMap = section('Path map');
  reportPathMap(pathMap);

  const neverSync = section('Never-sync');
  reportNeverSync(neverSync);

  const repository = section('Repository');
  const gitleaksReady = reportGitleaksProbe(repository);
  reportGitlinks(repository);
  reportRemote(repository);
  reportRebaseClean(repository);
  reportRebaseState(repository);
  reportActionsDrift(repository);

  const nomadVersion = section('Nomad Version');
  reportVersionCheck(nomadVersion);

  const housekeeping = section('Housekeeping');
  reportBackupsCheck(housekeeping);

  const depVersions = section('Dependency Versions');
  reportNodeEngineCheck(depVersions);
  reportGitleaksVersionCheck(depVersions);
  reportOptionalDeps(depVersions);

  const sharedScan = section('Shared scan');
  // Reuse the Repository-section readiness probe so reportCheckShared does not
  // re-spawn gitleaks for its own readiness on a --check-shared run; it still
  // probes standalone when called without a prior result. (The Dependency
  // Versions drift check above spawns `gitleaks version` separately, by design.)
  if (opts.checkShared === true) reportCheckShared(sharedScan, gitleaksReady);

  const schemaScan = section('Schema scan');
  if (opts.checkSchema === true) reportCheckSchema(schemaScan);

  const body = [
    nomadVersion,
    depVersions,
    host,
    links,
    hooksScan,
    settings,
    pathMap,
    neverSync,
    repository,
    housekeeping,
    sharedScan,
    schemaScan,
  ];
  return [...body, buildVerdictSection(body)];
}

/**
 * Read-only health check for the nomad install on the current host. Each
 * reporter pushes items into a named section; `renderDoctor` emits the final
 * Claude Code `/doctor`-style tree on stdout via `console.log` (no `ℹ︎`
 * prefix). FAILs in any section bubble up via `process.exitCode = 1` set
 * inside the individual reporters, so a piped
 * `nomad doctor 2>/dev/null` still exposes failures to scripts. Differs from
 * `cmdPull` / `cmdPush` / `resumeCmd`, where FATAL is on stderr.
 *
 * A "Running checks" spinner animates on stderr while the batched checks run
 * (the report is emitted all at once at the end), then vanishes the instant
 * the stdout report prints. `opts.startSpinner` injects the spinner factory
 * for tests (defaults to the real one).
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
export function cmdDoctor(
  opts: {
    checkShared?: boolean;
    checkSchema?: boolean;
    startSpinner?: (label: string) => SpinnerHandle;
  } = {},
): void {
  const makeSpinner = opts.startSpinner ?? realStartSpinner;
  // The spinner animates on stderr during the slow batched checks (gitleaks
  // probe, version curl, actions-drift). stop() runs in finally so a thrown
  // check still erases the spinner line (doctor is read-only and should not
  // throw, but be safe). renderDoctor runs AFTER stop() returns so no late
  // animation frame can interleave with the stdout report. stop() (not
  // succeed) means the spinner vanishes with no success glyph.
  const sp = makeSpinner('Running checks');
  let report: DoctorSection[];
  try {
    report = gatherDoctorSections(opts);
  } finally {
    sp.stop();
  }
  renderDoctor(report);
}
