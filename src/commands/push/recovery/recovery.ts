/**
 * Push-time interactive recovery menu for gitleaks findings. When `nomad push`
 * detects secrets in the staged tree and the process is running on a real TTY,
 * `resolveLeakFindings` presents a per-finding Redact / Allow / Drop / Skip
 * menu (default Skip), applies each resolved action, then re-stages and
 * re-scans. The push proceeds only when zero findings remain unresolved.
 *
 * Non-TTY contexts (CI, piped input) keep the existing `buildSessionAwareFatal`
 * abort unchanged: the function throws a `NomadFatal` carrying the existing
 * recovery body verbatim, so CI (which always runs non-TTY) sees no behavior
 * change from this recovery menu.
 *
 * `--redact-all` bypasses the prompt and redacts every real finding in batch
 * without requiring a TTY.
 *
 * Action helpers and per-finding dispatch live in
 * `commands.push.recovery.actions.ts`; the `--redact-all` batch half lives in
 * `commands.push.recovery.redact-all.ts`, keeping all three modules under the
 * 220-line advisory cap.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { PathMap } from '../../../config.ts';
import { repoHome } from '../../../config.ts';
import {
  type FindingAction,
  type PromptFn,
  allowAllFindings,
  allowFindingsByRule,
  collectActions,
  dispatchActions,
  findingKey,
} from './actions.ts';
import { redactAllFindings } from './redact-all.ts';
import { EXIT } from '../../../exit-codes.ts';
import type { Finding } from '../gitleaks.scan.ts';
import { scanFile } from '../gitleaks.scan.ts';
import { buildSessionAwareFatal, partitionFindings } from '../gitleaks.ts';
import type { LeakVerdict } from '../leak-verdict.ts';
import { NomadFatal, gitOrFatal, log } from '../../../utils.ts';

export type { FindingAction };

/**
 * Dependency injection object for `resolveLeakFindings`. Provides seams for
 * the prompt loop, the re-scan, the clock, and the TTY check so tests can
 * drive the interactive flow without a real terminal.
 */
export type RecoveryDeps = {
  /** Override TTY detection (default: `isTTY()`). */
  isTTYCheck?: () => boolean;
  /** Override `scanPushVerdict` for the post-action re-scan (receives the resolved repo root). */
  scanVerdict?: (repo: string) => LeakVerdict;
  /** Injectable clock for live-session detection (default: `Date.now`). */
  nowMs?: () => number;
  /** When true, redact all findings without prompting; no TTY required. */
  redactAll?: boolean;
  /** When true, allow (append to .gitleaksignore) all findings without prompting; no TTY required. */
  allowAll?: boolean;
  /** When set, allow only findings whose RuleID matches this value; no TTY required. */
  allowRule?: string;
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

/**
 * Re-stage the working tree and run the scan verdict. Throws `NomadFatal` when
 * the re-scan still reports a leak; returns the clean verdict otherwise. Used by
 * all non-interactive resolution modes (`--redact-all`, `--allow-all`,
 * `--allow <rule>`) so the re-stage + re-scan sequence is not duplicated.
 *
 * @param scanVerdict Injectable scan function (receives the resolved repo root).
 * @param repoHome Repository root path for `git add -A` and the re-scan.
 * @returns The clean `LeakVerdict` after re-staging and re-scanning.
 */
function applyThenRescan(
  scanVerdict: (repo: string) => LeakVerdict,
  repoHome: string,
): LeakVerdict {
  gitOrFatal(['add', '-A'], 'git add', repoHome);
  const next = scanVerdict(repoHome);
  if (next.leak) {
    const { bySession, other } = partitionFindings(next.findings);
    throw new NomadFatal(buildSessionAwareFatal(bySession, other), { code: EXIT.LEAK_BLOCKED });
  }
  return next;
}

/**
 * Snapshot `.gitleaksignore`, run `append` (which writes the allow entries),
 * then re-stage and re-scan via {@link applyThenRescan}. When the re-scan still
 * reports a leak the push aborts; the eagerly-written allow entries are rolled
 * back to the pre-append state so an aborted push leaves no allowlist lines in
 * the working tree (the secret was held back AND nothing the user did not
 * confirm is committed by a later push). Used by the `--allow-all` and
 * `--allow <rule>` paths.
 *
 * @param append Writes the allow fingerprints for the chosen mode.
 * @param scanVerdict Injectable scan function (receives the resolved repo root).
 * @param repoHome Repository root path for the ignore file and `git add -A`.
 * @returns The clean `LeakVerdict` after re-staging and re-scanning.
 */
function allowThenRescan(
  append: () => void,
  scanVerdict: (repo: string) => LeakVerdict,
  repoHome: string,
): LeakVerdict {
  const ignPath = join(repoHome, '.gitleaksignore');
  // Snapshot atomically: a read failure (missing file) means there is nothing
  // to restore, avoiding an existsSync check-then-read race on the file.
  let before: string | null;
  try {
    before = readFileSync(ignPath, 'utf8');
  } catch {
    before = null;
  }
  append();
  try {
    return applyThenRescan(scanVerdict, repoHome);
  } catch (err) {
    if (before === null) rmSync(ignPath, { force: true });
    else writeFileSync(ignPath, before, 'utf8');
    throw err;
  }
}

/**
 * Build the `NomadFatal` for an unresolved-leak abort. The single constructor
 * for this abort, shared by the non-TTY arm, the empty-findings guard, and the
 * `commitAndPush` backstop, so the `recovery ?? fallback` branch exists in
 * exactly one covered place.
 *
 * @param recovery The verdict's `recovery` body, or `null` when the verdict
 *   carries no recovery text.
 * @returns A `NomadFatal` with `code: EXIT.LEAK_BLOCKED`. Callers must `throw`
 *   the returned value themselves so TypeScript's control-flow analysis still
 *   sees the throw at the call site.
 */
export function leakBlockedFatal(recovery: string | null): InstanceType<typeof NomadFatal> {
  return new NomadFatal(recovery ?? 'gitleaks detected secrets', { code: EXIT.LEAK_BLOCKED });
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
 * body verbatim, so CI (which always runs non-TTY) sees no behavior change
 * from this recovery menu.
 *
 * The TTY flow prompts once per finding with R/A/D/S (default Skip on empty
 * input), collects all actions, dispatches them, then re-stages via
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
    allowAll = false,
    allowRule,
    makePrompt: makePromptFn = makeRealPrompt,
    scan = scanFile,
    printLegend = printRecoveryLegend,
  } = deps;

  const scanVerdict = deps.scanVerdict ?? (await import('../leak-verdict.ts')).scanPushVerdict;
  // Resolve roots once per command invocation to avoid a time-of-check/
  // time-of-use race: resolving twice could observe a different filesystem
  // state between the check and the use.
  const repo = repoHome();

  let current = verdict;

  if (redactAll) {
    redactAllFindings(current.findings, ts, map, nowMs, scan);
    return applyThenRescan(scanVerdict, repo);
  }

  if (allowAll) {
    return allowThenRescan(() => allowAllFindings(current.findings, repo), scanVerdict, repo);
  }

  if (allowRule !== undefined) {
    return allowThenRescan(
      () => {
        const matched = allowFindingsByRule(current.findings, allowRule, repo);
        if (matched === 0) log(`no findings matched rule ${allowRule}; re-scanning`);
      },
      scanVerdict,
      repo,
    );
  }

  if (!isTTYCheck()) {
    // A scan crash yields a leak verdict with no findings; every unresolved-leak
    // path aborts here.
    throw leakBlockedFatal(current.recovery);
  }

  // A leak:true verdict with zero findings means the scan did not complete
  // (e.g. a crashed gitleaks subprocess or an unparseable report). There is
  // nothing for the user to triage in that case, so abort before the prompt
  // and legend are ever constructed rather than falling through to a caller
  // that would treat the returned verdict as clean.
  if (current.leak && current.findings.length === 0) {
    throw leakBlockedFatal(current.recovery);
  }

  const prompt = makePromptFn();
  printLegend();

  while (current.leak && current.findings.length > 0) {
    const actions = await collectActions(current.findings, prompt);

    if (hasUnresolved(actions)) {
      // collectActions populates an entry for every finding, so `get` never
      // returns undefined here; an explicit `=== 'skip'` needs no default.
      const unresolved = current.findings.filter((f) => actions.get(findingKey(f)) === 'skip');
      const { bySession, other } = partitionFindings(unresolved);
      throw new NomadFatal(buildSessionAwareFatal(bySession, other), { code: EXIT.LEAK_BLOCKED });
    }

    dispatchActions(current.findings, actions, { ts, map, nowMs, repo, scan });
    gitOrFatal(['add', '-A'], 'git add', repo);
    current = scanVerdict(repo);
  }
  // The post-action re-scan above can itself crash, yielding another leak
  // verdict with zero findings. That shape exits the loop condition rather
  // than re-entering it, so without this the function would return a leaking
  // verdict to a caller. Re-assert the invariant on the way out: this function
  // never returns a verdict that still reports a leak.
  if (current.leak) throw leakBlockedFatal(current.recovery);
  return current;
}
