/**
 * Owns the staged gitleaks scan invoked at the end of `cmdPush`.
 *
 * Lives in its own module (Phase 5 D-04 split from `push-checks.ts`) so the
 * upcoming session-aware FATAL builder (gitleaks JSON parser + per-session
 * message composer) has a clean home while keeping every file under the
 * 200-line cap. `findGitlinks`, `probeGitleaks`, `gitleaksInstallHint`, and
 * `rebaseBeforePush` stay in `push-checks.ts`.
 *
 * `gitleaksInstallHint` is imported from `./push-checks.ts` because the
 * ENOENT branch surfaces the same platform-aware install scaffold whether
 * the missing binary is detected by `probeGitleaks` (top-of-flow) or by
 * this scan (defense-in-depth mid-flow).
 */

import { execFileSync } from 'node:child_process';

import { REPO_HOME } from './config.ts';
import { gitleaksInstallHint } from './push-checks.ts';
import { NomadFatal } from './utils.ts';

/**
 * Run gitleaks against the staged index. On non-zero exit (detection),
 * forwards gitleaks' own redacted stderr/stdout so the user sees which file
 * is dirty, then throws NomadFatal. Does NOT auto-rollback staging; the
 * user runs `git diff --cached` to identify the offending file.
 *
 * ENOENT branch is defense-in-depth: the presence probe at the top of
 * `cmdPush` should have caught a missing binary, but if `cmdPush` ever
 * bypasses the probe (or the user uninstalls gitleaks mid-flow) the same
 * install-hint FATAL fires here.
 */
export function runGitleaksScan(): void {
  try {
    execFileSync('gitleaks', ['protect', '--staged', '--redact', '-v'], {
      cwd: REPO_HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    if (e.code === 'ENOENT') throw new NomadFatal(gitleaksInstallHint());
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.stdout) process.stdout.write(e.stdout);
    throw new NomadFatal(
      'gitleaks detected secrets; review staged changes with git diff --cached and unstage offending files before retry',
    );
  }
}
