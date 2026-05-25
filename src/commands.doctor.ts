import {
  loadAndReportSettings,
  loadBaseSettings,
  reportGitleaksProbe,
  reportGitlinks,
  reportHostAndPaths,
  reportHostOverrides,
  reportNeverSync,
  reportPathMap,
  reportRebaseClean,
  reportRemote,
  reportRepoState,
  reportSharedLinks,
} from './commands.doctor.checks.ts';
import { reportCheckShared } from './commands.doctor.check-shared.ts';
import { reportNodeEngineCheck } from './commands.doctor.engine.ts';
import { renderDoctor, section } from './commands.doctor.format.ts';
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
 */
export function cmdDoctor(opts: { checkShared?: boolean } = {}): void {
  const host = section('Host');
  reportHostAndPaths(host);
  reportRepoState(host);

  const links = section('Shared links');
  reportSharedLinks(links);

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

  const version = section('Version');
  reportVersionCheck(version);
  reportNodeEngineCheck(version);
  reportGitleaksVersionCheck(version);

  const sharedScan = section('Shared scan');
  // Reuse the Repository-section readiness probe so reportCheckShared does not
  // re-spawn gitleaks for its own readiness on a --check-shared run; it still
  // probes standalone when called without a prior result. (The Version-section
  // drift check above spawns `gitleaks version` separately, by design.)
  if (opts.checkShared === true) reportCheckShared(sharedScan, gitleaksReady);

  renderDoctor([version, host, links, settings, pathMap, neverSync, repository, sharedScan]);
}
