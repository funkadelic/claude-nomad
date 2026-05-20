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
import { reportVersionCheck } from './commands.doctor.version.ts';

/**
 * Read-only health check for the nomad install on the current host. Emits
 * ALL diagnostics (PASS/WARN/FAIL) on stdout via `log()` so a piped
 * `nomad doctor 2>/dev/null` does not lose FAIL lines; failure is signaled
 * to scripts via `process.exitCode` instead. Differs from `cmdPull` /
 * `cmdPush` / `resumeCmd`, where FATAL is on stderr.
 */
export function cmdDoctor(): void {
  reportHostAndPaths();
  reportRepoState();
  reportSharedLinks();
  const base = loadBaseSettings();
  const settings = loadAndReportSettings();
  reportHostOverrides(base, settings);
  reportPathMap();
  reportNeverSync();
  reportGitleaksProbe();
  reportGitlinks();
  reportRemote();
  reportRebaseClean();
  reportVersionCheck();
}
