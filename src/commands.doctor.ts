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
import { renderDoctor, section } from './commands.doctor.format.ts';
import { reportVersionCheck } from './commands.doctor.version.ts';

/**
 * Read-only health check for the nomad install on the current host. Each
 * reporter pushes items into a named section; `renderDoctor` emits the final
 * Claude Code `/doctor`-style tree on stdout via `console.log` (no `ℹ︎`
 * prefix). FAILs in any section bubble up via `process.exitCode = 1` set
 * inside the individual reporters, so a piped
 * `nomad doctor 2>/dev/null` still exposes failures to scripts. Differs from
 * `cmdPull` / `cmdPush` / `resumeCmd`, where FATAL is on stderr.
 */
export function cmdDoctor(): void {
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
  reportGitleaksProbe(repository);
  reportGitlinks(repository);
  reportRemote(repository);
  reportRebaseClean(repository);

  const version = section('Version');
  reportVersionCheck(version);

  renderDoctor([version, host, links, settings, pathMap, neverSync, repository]);
}
