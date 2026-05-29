/**
 * Push-time interactive recovery menu for gitleaks findings. When `nomad push`
 * detects secrets in the staged tree and the process is running on a real TTY,
 * `resolveLeakFindings` presents a per-finding Redact / Allow / Drop / Skip
 * menu (default Skip), applies each resolved action, then re-stages and
 * re-scans. The push proceeds only when zero findings remain unresolved.
 *
 * Non-TTY contexts (CI, piped input) keep the existing `buildSessionAwareFatal`
 * abort unchanged: the function throws a `NomadFatal` carrying the existing
 * recovery body verbatim (D-01: zero CI behavior change).
 *
 * `--redact-all` bypasses the prompt and redacts every real finding in batch
 * without requiring a TTY.
 *
 * Action helpers and per-finding dispatch live in
 * `commands.push.recovery.actions.ts` to keep both modules under the 220-line
 * advisory cap.
 */

import { createInterface } from 'node:readline/promises';

import type { PathMap } from './config.ts';
import { REPO_HOME } from './config.ts';
import {
  type FindingAction,
  type PromptFn,
  collectActions,
  dispatchActions,
  findingKey,
  redactAllFindings,
} from './commands.push.recovery.actions.ts';
import type { Finding } from './push-gitleaks.scan.ts';
import { scanFile } from './push-gitleaks.scan.ts';
import { buildSessionAwareFatal, partitionFindings } from './push-gitleaks.ts';
import type { LeakVerdict } from './push-leak-verdict.ts';
import { NomadFatal, gitOrFatal } from './utils.ts';

export type { FindingAction };

/**
 * Dependency injection object for `resolveLeakFindings`. Provides seams for
 * the prompt loop, the re-scan, the clock, and the TTY check so tests can
 * drive the interactive flow without a real terminal.
 */
export type RecoveryDeps = {
  /** Override TTY detection (default: `isTTY()`). */
  isTTYCheck?: () => boolean;
  /** Override `scanPushVerdict` for the post-action re-scan. */
  scanVerdict?: () => LeakVerdict;
  /** Injectable clock for live-session detection (default: `Date.now`). */
  nowMs?: () => number;
  /** When true, redact all findings without prompting; no TTY required. */
  redactAll?: boolean;
  /** Injectable prompt factory for tests (default: real readline). */
  makePrompt?: () => PromptFn;
  /** Injectable single-file scan for redaction (default: `scanFile`). */
  scan?: (p: string) => Finding[] | null;
  /** Injectable legend printer for tests (default: `printRecoveryLegend`). */
  printLegend?: () => void;
};

/**
 * True when both stdin and stdout are interactive TTYs. Accepts injectable
 * stream objects so tests can drive the branch without a real TTY.
 *
 * @param stdin Readable with optional `isTTY` flag (default: `process.stdin`).
 * @param stdout Writable with optional `isTTY` flag (default: `process.stdout`).
 * @returns True iff both streams report `isTTY === true`.
 */
export function isTTY(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * True when any value in the actions map is `'skip'`, meaning at least one
 * finding was left unresolved. Pure, no I/O.
 *
 * @param actions Per-finding action map keyed by `findingKey`.
 * @returns True when at least one action is `'skip'`.
 */
export function hasUnresolved(actions: Map<string, FindingAction>): boolean {
  for (const action of actions.values()) {
    if (action === 'skip') return true;
  }
  return false;
}

/**
 * Print a one-time action legend to stdout before the interactive menu loop.
 * Called exactly once on the TTY path; never called on non-TTY or --redact-all.
 *
 * @param print Output sink (default: `console.log`). Injectable for tests.
 */
export function printRecoveryLegend(print: (line: string) => void = console.log): void {
  print('');
  print('Recovery actions:');
  print('  Redact       - scrub the secret from the local transcript, push the cleaned copy');
  print('  Allow        - mark as false positive (adds a .gitleaksignore fingerprint), push as-is');
  print('  Drop session - exclude this session from this push (local transcript kept, running');
  print('                 session is not stopped)');
  print('  Skip         - leave unresolved (the push aborts)');
  print('');
}

/** Build the real-TTY readline-based prompt function (one interface per call). */
function makeRealPrompt(): PromptFn {
  return async (prompt: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };
}

/**
 * Resolve the gitleaks findings from `verdict` interactively (TTY path) or
 * via `--redact-all` (non-interactive batch path). On a non-TTY context with
 * no `--redact-all` flag, throws `NomadFatal` carrying the existing recovery
 * body verbatim (D-01: zero CI behavior change).
 *
 * TTY flow (D-02, D-03): prompts once per finding with R/A/D/S (default Skip
 * on empty input), collects all actions, dispatches them, then re-stages via
 * `git add -A` and re-scans. If the re-scan still has findings the menu loops
 * on the new set. If any finding remains Skipped after triage, throws the
 * session-aware FATAL so the push aborts with the same non-zero exit.
 *
 * @param verdict The current leak verdict from `scanPushVerdict`.
 * @param ts Backup timestamp created at the start of this push run.
 * @param map Parsed `path-map.json` for session path resolution.
 * @param deps Optional dependency overrides for testing.
 * @returns The final clean `LeakVerdict` after all findings are resolved.
 */
export async function resolveLeakFindings(
  verdict: LeakVerdict,
  ts: string,
  map: PathMap,
  deps: RecoveryDeps = {},
): Promise<LeakVerdict> {
  const {
    isTTYCheck = isTTY,
    nowMs = Date.now,
    redactAll = false,
    makePrompt: makePromptFn = makeRealPrompt,
    scan = scanFile,
    printLegend = printRecoveryLegend,
  } = deps;

  const scanVerdict = deps.scanVerdict ?? (await import('./push-leak-verdict.ts')).scanPushVerdict;

  let current = verdict;

  if (redactAll) {
    redactAllFindings(current.findings, ts, map, nowMs, scan);
    gitOrFatal(['add', '-A'], 'git add', REPO_HOME);
    const next = scanVerdict();
    if (next.leak) {
      const { bySession, other } = partitionFindings(next.findings);
      throw new NomadFatal(buildSessionAwareFatal(bySession, other));
    }
    return next;
  }

  if (!isTTYCheck()) {
    // Every leak:true verdict has a non-null recovery body. The fallback covers
    // the defensive unreachable case (scan-crash with leak=true).
    /* c8 ignore next */
    throw new NomadFatal(current.recovery ?? 'gitleaks detected secrets');
  }

  const prompt = makePromptFn();
  printLegend();

  while (current.leak && current.findings.length > 0) {
    const actions = await collectActions(current.findings, prompt);

    if (hasUnresolved(actions)) {
      const unresolved = current.findings.filter(
        (f) => (actions.get(findingKey(f)) ?? 'skip') === 'skip',
      );
      const { bySession, other } = partitionFindings(unresolved);
      throw new NomadFatal(buildSessionAwareFatal(bySession, other));
    }

    dispatchActions(current.findings, actions, ts, map, nowMs, scan);
    gitOrFatal(['add', '-A'], 'git add', REPO_HOME);
    current = scanVerdict();
  }
  return current;
}
