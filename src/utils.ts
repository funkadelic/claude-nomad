import { execFileSync } from 'node:child_process';

import { dim, failGlyph, green, infoGlyph, okGlyph, red, warnGlyph, yellow } from './color.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';

/**
 * Print an informational line prefixed with the dim `ℹ︎` glyph (U+2139+VS15)
 * to stdout. Matches the doctor-style left-gutter glyph format so the whole
 * CLI shares one visual vocabulary instead of the prior `[nomad]` text prefix
 * coexisting with doctor's status glyphs.
 */
export const log = (msg: string): void => console.log(`${dim(infoGlyph)} ${msg}`);

/**
 * Print a success line prefixed with the green `✓` glyph to stdout. Use for
 * positive terminators (e.g., `summary: clean`) where a status confirmation is
 * load-bearing.
 */
export const ok = (msg: string): void => console.log(`${green(okGlyph)} ${msg}`);

/**
 * Print a warning line prefixed with the yellow `⚠︎` glyph to stderr. Use for
 * non-fatal conditions the operator should notice (lock contention, partial
 * sync outcomes, schema drift). Routes through `console.error` so both
 * `console.error` spies and `process.stderr.write` spies in tests catch it.
 */
export const warn = (msg: string): void => {
  console.error(`${yellow(warnGlyph)} ${msg}`);
};

/**
 * Print a fatal-error line prefixed with the red `✗` glyph to stderr. Use for
 * NomadFatal-equivalent failures surfaced to the user; the glyph carries the
 * severity so callers do not need a redundant `FATAL:` text token. Routes
 * through `console.error` so both `console.error` spies and
 * `process.stderr.write` spies in tests catch it.
 */
export const fail = (msg: string): void => {
  console.error(`${red(failGlyph)} ${msg}`);
};

/**
 * Print a dim, two-space-indented line to stdout with no leading glyph. The
 * glyph-less companion to `log()`, used to enumerate items (for example the
 * dry-run prune targets in `cmdClean`) so the enumerated rows read as a list
 * sitting under a single glyph-prefixed summary line rather than each carrying
 * a redundant `ℹ︎`.
 */
export const item = (msg: string): void => console.log(dim(`  ${msg}`));

/**
 * Sentinel error class for fatal nomad failures. Thrown by `die()` and caught
 * by top-level command wrappers (cmdPull, cmdPush, nomad.ts dispatcher) so a
 * `finally` block can release locks before the process exits. Avoids the
 * pre-fix bug where `process.exit()` skipped pending `finally` clauses and
 * leaked the lockfile.
 *
 * Carries an optional `code` classifying which {@link EXIT} value the process
 * should exit with; defaults to `EXIT.GENERIC_FAILURE` so every existing
 * single-argument caller keeps its current exit-1 behavior unchanged.
 */
export class NomadFatal extends Error {
  readonly code: ExitCode;

  constructor(message: string, opts: { code?: ExitCode } = {}) {
    super(message);
    this.name = 'NomadFatal';
    this.code = opts.code ?? EXIT.GENERIC_FAILURE;
  }
}

/**
 * Termination boundary for tests. A real `process.exit()` ends the process
 * before any surrounding `catch` can run; a test's `process.exit` mock cannot
 * do that, so it throws this sentinel instead. The top-level crash funnel
 * (`handleTopLevelError` in `nomad.ts`) re-throws a `ProcessExit` untouched
 * rather than treating it as an unexpected error, so exit-path unit tests
 * never route an expected usage exit through the crash-report writer. Real
 * `process.exit` terminates, so this type is never constructed in production.
 *
 * Carries the exit `code` the mock was called with; the message embeds it as
 * `exit:<code>` so tests can assert on the rejection.
 */
/**
 * Registered-symbol brand for {@link ProcessExit}. `Symbol.for` resolves to
 * the same symbol in every module realm, so the brand survives the realm
 * duplication `vi.resetModules()` introduces between a test and the
 * dynamically re-imported `nomad.ts`, while (unlike a mutable `Error.name`) it
 * cannot be spoofed by an unrelated error that happens to be named the same.
 */
const PROCESS_EXIT_BRAND: unique symbol = Symbol.for('claude-nomad.ProcessExit');

export class ProcessExit extends Error {
  readonly code: string | number | null | undefined;
  readonly [PROCESS_EXIT_BRAND] = true;

  constructor(code: string | number | null | undefined) {
    super(`exit:${String(code)}`);
    this.name = 'ProcessExit';
    this.code = code;
  }
}

/**
 * True when `err` is a {@link ProcessExit} sentinel, identified by its
 * {@link PROCESS_EXIT_BRAND} symbol rather than `instanceof` (which breaks
 * across the `vi.resetModules()` realm split) or the mutable `name` (which any
 * error could carry). A plain `Error` renamed to `ProcessExit` is NOT matched,
 * so it still routes through crash handling. `err` is `unknown` (any thrown
 * value), so the brand read is guarded: a throwing getter or Proxy trap
 * degrades to `false` rather than aborting the crash funnel.
 */
export function isProcessExit(err: unknown): err is ProcessExit {
  if (typeof err !== 'object' || err === null) return false;
  try {
    return (err as Record<symbol, unknown>)[PROCESS_EXIT_BRAND] === true;
  } catch {
    return false;
  }
}

/**
 * Throw a `NomadFatal` with the given message. Callers should `catch` it in
 * the cmdPull/cmdPush try/finally so the lock is released before exit.
 *
 * @param msg - The fatal error message.
 * @param opts - Optional `code` classifying the {@link EXIT} value to exit
 *   with; defaults to `EXIT.GENERIC_FAILURE` when omitted.
 */
export const die = (msg: string, opts: { code?: ExitCode } = {}): never => {
  throw new NomadFatal(msg, opts);
};

/**
 * Shell-free, untrimmed `git status --porcelain=v1 -z` reader. Untrimmed
 * because porcelain v1 -z records start with a 2-char status plus 1 space,
 * and the first record's leading space is part of the format (e.g.
 * `" M path\0"` for unstaged-modified). Going through `sh` would strip that
 * space and shift the fixed-offset parse in `parsePorcelainZ`.
 *
 * `opts.untrackedAll` (default `false`): when `true`, passes
 * `--untracked-files=all` so git emits one record per untracked file instead
 * of collapsing a fully-untracked subtree to its highest all-untracked parent
 * directory (`?? shared/extras/`). The push allow-list (issue #111) needs the
 * per-file paths so its `shared/extras/<logical>/<dirname>/` child prefix
 * matches; the working-tree-clean checks in `cmdUpdate` and `cmdDoctor` only
 * care whether output is empty, so they keep the cheaper default-collapse
 * behavior. Opt-in rather than a global default so those consumers do not
 * pay for the deeper walk.
 *
 * @param cwd - Working directory for the git invocation; defaults to the process cwd.
 * @param opts - Reader options. `untrackedAll` expands collapsed untracked directory records into per-file paths.
 * @returns The raw NUL-delimited porcelain v1 output as a string.
 */
export const gitStatusPorcelainZ = (
  cwd?: string,
  opts: { untrackedAll?: boolean } = {},
): string => {
  const args = ['status', '--porcelain=v1', '-z'];
  if (opts.untrackedAll === true) args.push('--untracked-files=all');
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
};

/**
 * Shell-free, untrimmed git stdout capture. Returns the raw output string
 * WITHOUT calling `.trim()` so that NUL-delimited records (e.g. from
 * `git diff --name-status -z`) are preserved exactly as git produced them.
 * Trimming would corrupt the first or last NUL-delimited field. This is the
 * NUL-preserving sibling of `gitStatusPorcelainZ`, used by the `.planning`
 * diff parser (`extras-sync.planning-diff.ts`).
 *
 * @param args - Git arguments (excludes the 'git' binary name itself).
 * @param cwd - Working directory for the git invocation; defaults to the process cwd.
 * @returns The raw, untrimmed stdout string from the git invocation.
 */
export function gitCaptureRaw(args: readonly string[], cwd?: string): string {
  return execFileSync('git', args as string[], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/**
 * Shell-free git stdout capture returning the raw `Buffer` (no `.toString()`),
 * so binary-safe byte comparison is possible. Used by the `.planning`
 * delete-propagation divergence check to compare a host file against its
 * pre-rebase repo blob (`git show <sha>:<path>`) without a lossy UTF-8 decode.
 *
 * @param args - Git arguments (excludes the 'git' binary name itself).
 * @param cwd - Working directory for the git invocation; defaults to the process cwd.
 * @returns The raw stdout as a `Buffer`.
 */
export function gitCaptureBuffer(args: readonly string[], cwd?: string): Buffer {
  return execFileSync('git', args as string[], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run `git <args>` in `cwd`, forwarding stderr and converting non-zero exits
 * to `NomadFatal`. Without this wrap, an ExecException would bubble past the
 * cmdPull/cmdPush NomadFatal-only catch blocks and surface as a stack trace;
 * the finally still releases the lock, but the user UX degrades.
 */
export function gitOrFatal(args: readonly string[], context: string, cwd?: string): void {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    if (e.stderr) process.stderr.write(e.stderr);
    throw new NomadFatal(`${context} failed`);
  }
}
