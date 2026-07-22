/**
 * Pure crash-report builder. Zero I/O: composes a bounded, structurally
 * scrubbed plain-text report describing an unexpected error, the invoking
 * argv, and process metadata. Deliberately excludes any environment
 * snapshot and any file contents; the composed text is handed to
 * `redactWithGitleaks` (`./crash-report.redact.ts`) for best-effort
 * value-based secret redaction, then to `writeCrashReport`
 * (`./crash-report.write.ts`) to persist it.
 */

/** Maximum number of stack-trace lines retained in a crash report. */
export const CRASH_MAX_STACK_LINES = 50;

/** Maximum number of argv tokens retained in a crash report. */
export const CRASH_MAX_ARGV = 32;

/** Maximum length (characters) of a single retained argv token before it is truncated. */
export const CRASH_MAX_ARGV_TOKEN_LENGTH = 200;

/** Maximum total byte length of the composed crash report before truncation. */
export const CRASH_MAX_REPORT_BYTES = 16_384;

/** Marker appended when the composed report is truncated to fit the byte cap. */
const TRUNCATION_MARKER = '\n[... truncated ...]\n';

/**
 * Inputs to {@link buildCrashReport}. `homeDir`/`hostLabel` are the values
 * `scrubStructural` replaces; callers pass `home()`/`HOST` in production and
 * fixed strings in tests.
 */
export type CrashReportInput = {
  /** The value thrown or passed to an uncaughtException/unhandledRejection listener. */
  err: unknown;
  /** The invoking process argv (or a subset), included verbatim (subject to capping). */
  argv: readonly string[];
  /** The running nomad version (e.g. from `package.json`). */
  version: string;
  /** `process.platform`, or an injected value in tests. */
  platform: string;
  /** ISO timestamp string for the report. */
  timestamp: string;
  /** Absolute home directory to scrub from the report (typically `home()`). */
  homeDir: string;
  /** Host label to scrub from the report (typically `HOST`); may be empty. */
  hostLabel: string;
};

/** Normalized error fields, tolerant of non-`Error` thrown values. */
type NormalizedError = {
  name: string;
  message: string;
  stack: string | undefined;
};

/**
 * Best-effort string form of a non-`Error` thrown value. Prefers
 * `JSON.stringify` (covers plain objects, arrays, numbers, booleans, null);
 * falls back to `String(value)` when `JSON.stringify` returns `undefined`
 * (e.g. the input is `undefined` itself) or throws (e.g. a circular object).
 * `String(value)` can itself throw for a value with a throwing `toString`/
 * `Symbol.toPrimitive`, so that call is guarded too and degrades to a fixed
 * placeholder rather than escaping into the crash path.
 */
function safeStringify(value: unknown): string {
  try {
    const json: string | undefined = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // JSON.stringify threw (circular graph or a throwing toJSON); fall
    // through to the String() attempt below.
  }
  try {
    return String(value);
  } catch {
    return '(unstringifiable thrown value)';
  }
}

/**
 * Normalize `err` into a `{ name, message, stack }` triple. Real `Error`
 * instances pass their own fields through; a `string` throw becomes the
 * message verbatim; anything else (object, number, `undefined`, ...) is
 * serialized via {@link safeStringify}. Never throws.
 */
function normalizeError(err: unknown): NormalizedError {
  try {
    if (err instanceof Error) {
      return { name: err.name, message: err.message, stack: err.stack };
    }
  } catch {
    return { name: 'Error', message: '(unreadable Error)', stack: undefined };
  }
  if (typeof err === 'string') {
    return { name: 'NonErrorThrow', message: err, stack: undefined };
  }
  return { name: 'NonErrorThrow', message: safeStringify(err), stack: undefined };
}

/**
 * Cap a stack trace to at most `CRASH_MAX_STACK_LINES` lines. Returns a
 * placeholder when no stack is available (non-`Error` throw, or an `Error`
 * whose `.stack` was cleared).
 */
function boundedStack(stack: string | undefined): string {
  if (stack === undefined) return '(no stack available)';
  return stack.split('\n').slice(0, CRASH_MAX_STACK_LINES).join('\n');
}

/**
 * Cap `argv` to at most `CRASH_MAX_ARGV` tokens, each length-clamped to
 * `CRASH_MAX_ARGV_TOKEN_LENGTH` characters (with a truncation suffix on any
 * clamped token).
 */
function clampArgv(argv: readonly string[]): string[] {
  return argv.slice(0, CRASH_MAX_ARGV).map((tok) => {
    if (tok.length <= CRASH_MAX_ARGV_TOKEN_LENGTH) return tok;
    return tok.slice(0, CRASH_MAX_ARGV_TOKEN_LENGTH) + '...';
  });
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, appending
 * `TRUNCATION_MARKER` when truncation occurs. No-op (returns `text`
 * unchanged) when already within budget.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8'));
  // UTF-8 characters are at most 4 bytes, so slicing to `budget` characters
  // first is always >= the eventual byte-trimmed result, then trim one
  // character at a time until the byte budget is satisfied.
  let sliced = text.slice(0, budget);
  while (Buffer.byteLength(sliced, 'utf8') > budget) {
    sliced = sliced.slice(0, -1);
  }
  return sliced + TRUNCATION_MARKER;
}

/**
 * Replace every literal occurrence of `homeDir` with `~` and, when
 * `hostLabel` is non-empty, every literal occurrence of `hostLabel` with
 * `<host>`. Both replacements use `split`/`join` (no regex, so no
 * special-character escaping concerns) and are order-independent since a
 * real home directory path and hostname never overlap as substrings of one
 * another. A blank `homeDir` or `hostLabel` is treated as a no-op for that
 * replacement rather than corrupting the text (an empty-string `split`
 * would otherwise insert the replacement between every character).
 *
 * @param text Text to scrub.
 * @param homeDir Absolute home directory path to replace with `~`.
 * @param hostLabel Host label to replace with `<host>`; empty is a no-op.
 * @returns The scrubbed text.
 */
export function scrubStructural(text: string, homeDir: string, hostLabel: string): string {
  let out = homeDir.length > 0 ? text.split(homeDir).join('~') : text;
  if (hostLabel.length > 0) out = out.split(hostLabel).join('<host>');
  return out;
}

/**
 * Structural credential scrub applied to the composed report BEFORE the
 * gitleaks value-based pass. It is a fail-safe backstop for the gitleaks-less
 * host: when `scanFile` returns null (binary absent, common on a fresh host's
 * first pull), `redactWithGitleaks` applies no token scrubbing, so a raw
 * `execFileSync` error whose `.message` embeds a credential (most commonly a
 * git remote URL like `https://x-access-token:ghp_...@github.com`) would
 * otherwise reach disk unredacted. Two high-signal, low-false-positive
 * patterns:
 *
 * 1. URL userinfo: the `user[:pass]@` segment of any `scheme://...@host` URL is
 *    replaced with `<redacted>@`, so an embedded token in a remote URL is
 *    scrubbed whether or not gitleaks recognizes it.
 * 2. GitHub token literals: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` classic PATs and
 *    `github_pat_` fine-grained tokens (20+ trailing chars) are replaced with
 *    `<redacted-token>`, covering a token that appears outside a URL (e.g. an
 *    `Authorization: token ...` header echoed into an error).
 *
 * Not a replacement for the gitleaks pass (which catches far more): this only
 * closes the specific error-text leak surface on hosts where that pass cannot
 * run. Applied to the whole report (not just the error line) so a credential in
 * a stack frame or argv token is covered too.
 *
 * @param text Text to scrub.
 * @returns The text with credential-shaped substrings replaced.
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(/:\/\/[^\s/@]+@/g, '://<redacted>@')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-token>')
    .replace(/\bgithub_pat_\w{20,}\b/g, '<redacted-token>');
}

/**
 * Compose one bounded, plain-text crash report from an unexpected error and
 * process metadata. Pure: no filesystem or network access. The report
 * includes the nomad version, the (capped) invoking command, the error name
 * and message, a (line-capped) stack trace, the platform and Node version,
 * and a timestamp. It deliberately excludes any environment variable dump
 * and any file contents.
 *
 * The composed text is passed through {@link scrubStructural} and
 * {@link scrubCredentials} FIRST, then byte-capped to `CRASH_MAX_REPORT_BYTES`
 * (with a truncation marker on overflow) as the final step. Scrubbing before
 * truncating is load-bearing: it prevents truncation from cutting through a
 * `homeDir`/`hostLabel` occurrence (or a credential span) and leaving a partial
 * (undetectable) fragment, and it keeps the scrub (which can expand short labels
 * into `<host>`) from pushing the output back over the byte cap. The credential
 * scrub is a structural backstop for the gitleaks-less host, where the later
 * value-based pass cannot run; see {@link scrubCredentials}. The returned string
 * is therefore always both scrubbed and within budget before any caller writes
 * it to disk or hands it to the gitleaks-based redactor.
 *
 * @param input See {@link CrashReportInput}.
 * @returns The bounded, structurally-scrubbed crash report text.
 */
export function buildCrashReport(input: CrashReportInput): string {
  const { err, argv, version, platform, timestamp, homeDir, hostLabel } = input;
  const normalized = normalizeError(err);
  const command = clampArgv(argv).join(' ');
  const stack = boundedStack(normalized.stack);
  const composed = [
    'nomad crash report',
    `version: ${version}`,
    `command: ${command}`,
    `error: ${normalized.name}: ${normalized.message}`,
    'stack:',
    stack,
    `platform: ${platform} (node ${process.version})`,
    `timestamp: ${timestamp}`,
  ].join('\n');
  const scrubbed = scrubCredentials(scrubStructural(composed, homeDir, hostLabel));
  return truncateToBytes(scrubbed, CRASH_MAX_REPORT_BYTES);
}
