/**
 * Process-level bootstrap for the `nomad` binary: the home-directory
 * preflight, the single fatal-error funnel, and the test-only crash seam.
 * Split out of `nomad.ts` so that file stays argv dispatch.
 */

import { home } from '../core/config.ts';
import { handleCrash } from '../core/crash-report.write.ts';
import { EXIT } from '../core/exit-codes.ts';
import { isUserAbort } from '../core/user-abort.ts';
import { fail, isProcessExit, NomadFatal, warn } from '../core/utils.ts';

import pkg from '../../package.json' with { type: 'json' };

/**
 * Single funnel for every unexpected top-level error, so a `NomadFatal` can
 * never reach the crash-report path from any of the three call sites. A
 * `ProcessExit` sentinel is re-thrown untouched, a `NomadFatal` keeps its own
 * message and code, a Ctrl+C cancel exits quietly, anything else crash-reports.
 */
export function handleTopLevelError(err: unknown): never {
  // Typed `never`: an uncaughtException listener suppresses Node's auto-exit,
  // so every branch must call process.exit explicitly or the process hangs.
  if (isProcessExit(err)) throw err;
  if (err instanceof NomadFatal) {
    fail(err.message);
    process.exit(err.code);
  }
  if (isUserAbort(err)) {
    warn('cancelled.');
    process.exit(EXIT.INTERRUPTED);
  }
  /* c8 ignore next -- package.json always carries bugs.url; the fallback is defensive */
  const issuesUrl = pkg.bugs?.url ?? 'https://github.com/funkadelic/claude-nomad/issues';
  handleCrash(err, process.argv, {
    version: pkg.version,
    platform: process.platform,
    issuesUrl,
  });
  process.exit(EXIT.GENERIC_FAILURE);
}

/** Route Node's async error events through the same funnel as the dispatch catch. */
export function installTopLevelHandlers(): void {
  process.on('uncaughtException', handleTopLevelError);
  process.on('unhandledRejection', handleTopLevelError);
}

/** Exit before dispatch when the home directory cannot be resolved at all. */
export function requireHome(): void {
  if (home()) return;
  fail(
    'could not determine home directory (HOME env unset and no uid mapping). Set HOME and retry.',
  );
  process.exit(EXIT.GENERIC_FAILURE);
}

/**
 * Test-only crash seam, gated on env vars set exclusively by
 * `src/nomad.crash.test.ts`; never fires in normal use. Not documented in
 * `help.ts`.
 */
export function forceTestCrash(): void {
  if (process.env.NOMAD_TEST_FORCE_CRASH) {
    throw new Error('forced test crash (NOMAD_TEST_FORCE_CRASH)');
  }
  /* c8 ignore start -- scheduling the deliberate rejection in-process would fail the worker */
  if (process.env.NOMAD_TEST_FORCE_ASYNC_CRASH) {
    setImmediate(() => {
      // Deliberately unhandled: void discards the reference without attaching a
      // rejection handler, so Node's unhandledRejection listener catches it.
      void Promise.reject(new Error('forced test async crash (NOMAD_TEST_FORCE_ASYNC_CRASH)'));
    });
  }
  /* c8 ignore stop */
}
