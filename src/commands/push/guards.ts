import { join, relative } from 'node:path';

import { findGitlinks } from './checks.ts';
import { die, fail, NomadFatal } from '../../utils.ts';

/**
 * Walk `shared/` for nested `.git` entries copied in from a host's encoded
 * session dir. A gitlink would otherwise push as a submodule via the
 * `shared/projects/<logical>/` prefix. Emits a per-hit FATAL line on stderr and
 * throws a summarizing `NomadFatal` (caught by `cmdPush` so the lock releases).
 * Runs AFTER `remapPush` so it inspects the post-copy tree.
 *
 * @param repo Resolved repo root path for this invocation.
 */
export function guardGitlinks(repo: string): void {
  const gitlinks = findGitlinks(join(repo, 'shared'));
  if (gitlinks.length === 0) return;
  for (const p of gitlinks) {
    // Repo-relative paths are forward-slash on every platform (matches how
    // git itself reports paths); relative() returns a native (backslash on
    // win32) separator, so normalize before display.
    const rel = relative(repo, p).replaceAll('\\', '/');
    fail(`gitlink: ${rel} would push as submodule (run: rm -rf ${rel} or remove the nested repo)`);
  }
  const noun = gitlinks.length === 1 ? 'entry' : 'entries';
  throw new NomadFatal(
    `gitlink trap: ${gitlinks.length} nested .git ${noun} in shared/; remove before retry`,
  );
}

/**
 * Defense-in-depth guard for push resolution-mode mutual exclusivity.
 * The argv parser already enforces these, but `runPushCore` re-checks as a
 * second gate (mirroring `cmdClean`'s `--older-than`/`--keep` precedent). It
 * lives in `runPushCore` rather than `cmdPush` so the `cmdSync` compose seam,
 * which calls `runPushCore` directly, is covered too. Calls `die()` on any
 * conflicting combination: two resolution modes together, or any resolution
 * mode (including `--redact-all`) combined with `--dry-run` (a dry-run resolves
 * nothing).
 *
 * @param dryRun True when `--dry-run` was passed.
 * @param redactAll True when `--redact-all` was passed.
 * @param allowAll True when `--allow-all` was passed.
 * @param allowRule Rule id from `--allow <rule>`, or undefined.
 */
export function guardResolutionModeConflicts(
  dryRun: boolean,
  redactAll: boolean,
  allowAll: boolean,
  allowRule: string | undefined,
): void {
  const hasAllow = allowAll || allowRule !== undefined;
  const wantsResolution = redactAll || hasAllow;
  if (redactAll && hasAllow) {
    die('--redact-all, --allow-all, and --allow are mutually exclusive resolution modes');
  }
  if (allowAll && allowRule !== undefined) {
    die('--redact-all, --allow-all, and --allow are mutually exclusive resolution modes');
  }
  if (dryRun && wantsResolution) {
    die(
      '--redact-all, --allow-all, and --allow cannot be combined with --dry-run (dry-run resolves nothing)',
    );
  }
}
