import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  reportDroppedNamesMigration,
  reportHostAndPaths,
  reportHostKeyAlignment,
  reportRepoState,
  reportSharedLinks,
} from './commands.doctor.checks.repo.ts';
import {
  loadAndReportSettings,
  loadBaseSettings,
  reportHostOverrides,
} from './commands.doctor.checks.settings.ts';
import { reportNeverSync, reportPathMap } from './commands.doctor.checks.pathmap.ts';
import { reportSkillsDivergence } from './commands.doctor.checks.skills.ts';
import {
  reportGitleaksProbe,
  reportGitIdentity,
  reportGitlinks,
  reportOrphanedAutostash,
  reportRebaseClean,
  reportRebaseState,
  reportRemote,
} from './commands.doctor.checks.git-state.ts';
import { reportBackupsCheck } from './commands.doctor.checks.backups.ts';
import { reportCheckRemote } from './commands.doctor.check-remote.ts';
import { reportCheckSchema } from './commands.doctor.check-schema.ts';
import { reportCheckShared } from './commands.doctor.check-shared.ts';
import { reportHookScopeCheck } from './commands.doctor.checks.hooks.scope.ts';
import { reportHooksTargetCheck } from './commands.doctor.checks.hooks.ts';
import { reportPreserveSymlinksCheck } from './commands.doctor.checks.hooks.preserve-symlinks.ts';
import {
  reportHooksBaseSelfCleanNote,
  reportSettingsDriftCheck,
} from './commands.doctor.checks.settings-drift.ts';
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
import { compactSections } from './commands.doctor.compact.ts';

/**
 * Run every doctor reporter and assemble the final ordered section array
 * (body sections followed by the verdict). All check branching lives here so
 * `cmdDoctor` stays linear under the cognitive-complexity gate.
 *
 * INVARIANT: reporters MUST NOT write to stdout or stderr. The spinner owns the
 * terminal during gathering (it animates on stderr); reporters only populate
 * their section objects, and every subprocess they spawn must capture child
 * streams (`stdio: 'pipe'`, never `'inherit'` or a bare `execSync`) so child
 * output cannot land on top of the live spinner frame. `renderDoctor` is the
 * sole stdout writer, and it runs only after the spinner has stopped.
 */
function gatherDoctorSections(opts: {
  checkShared?: boolean;
  checkSchema?: boolean;
  checkRemote?: boolean;
}): DoctorSection[] {
  const host = section('Environment');
  reportHostAndPaths(host);
  reportHostKeyAlignment(host);
  reportRepoState(host);

  const links = section('Shared links');
  // Tolerantly read path-map.json for sharedDirs: doctor is read-only and
  // must not throw on a missing or malformed map. Fall back to { projects: {} }
  // so hooks + static SHARED_LINKS rows still emit on a fresh host.
  const mapPath = join(repoHome(), 'path-map.json');
  const rawMap = existsSync(mapPath) ? readJsonSafe<PathMap>(mapPath, mapPath, links) : null;
  const map: PathMap = rawMap ?? { projects: {} };
  reportSharedLinks(links, map);
  reportDroppedNamesMigration(links);

  const hooksScan = section('Hook targets');
  reportHooksTargetCheck(hooksScan);
  reportHookScopeCheck(hooksScan);
  reportPreserveSymlinksCheck(hooksScan);

  const settings = section('Settings');
  const base = loadBaseSettings(settings);
  const parsedSettings = loadAndReportSettings(settings);
  reportHostOverrides(settings, base, parsedSettings);
  reportSettingsDriftCheck(settings);
  reportHooksBaseSelfCleanNote(settings);

  const pathMap = section('Path map');
  reportPathMap(pathMap);

  const neverSync = section('Never-sync');
  reportNeverSync(neverSync);

  const skills = section('Skills');
  reportSkillsDivergence(skills);

  const repository = section('Repository');
  const gitleaksReady = reportGitleaksProbe(repository);
  reportGitlinks(repository);
  reportRemote(repository);
  reportGitIdentity(repository);
  reportRebaseClean(repository);
  reportRebaseState(repository);
  reportOrphanedAutostash(repository);
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

  const remoteCheck = section('Remote check');
  if (opts.checkRemote === true) reportCheckRemote(remoteCheck);

  const body = [
    nomadVersion,
    depVersions,
    host,
    links,
    hooksScan,
    settings,
    pathMap,
    neverSync,
    skills,
    repository,
    housekeeping,
    sharedScan,
    schemaScan,
    remoteCheck,
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
 *
 * `opts.checkRemote` (the `--check-remote` sub-flag) appends a "Remote check"
 * section that runs up to two bounded git subprocesses against the locally-cached
 * `origin/main` remote-tracking ref: verifies `shared/` exists and
 * `path-map.json` parses to a valid shape. Also OFF by default (the default
 * run stays offline and lockless). All failure modes degrade to a WARN/SKIP;
 * `process.exitCode` is never set.
 *
 * `opts.verbose` (the `--verbose` / `--all` / `-v` flag) restores the full
 * per-check tree. By default the report is collapsed via `compactSections` to
 * the Nomad Version row, the Environment repo-state line, any section carrying a
 * WARN/FAIL (OK/info rows stripped), and the Summary verdict. Filtering is
 * purely presentational and runs after gathering, so the FAIL exit code set by
 * reporters is unaffected in either mode.
 */
export function cmdDoctor(
  opts: {
    checkShared?: boolean;
    checkSchema?: boolean;
    checkRemote?: boolean;
    verbose?: boolean;
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
  renderDoctor(opts.verbose === true ? report : compactSections(report));
}
