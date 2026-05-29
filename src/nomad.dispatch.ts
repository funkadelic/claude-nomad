/**
 * Set-based argv flag parser shared by the `init` and `update` dispatcher
 * arms. Scans `process.argv` from index 3 onward, accepting only flags in
 * `known` and rejecting any unknown flag or duplicate (so `--dry-run
 * --dry-run` is a typo, not a no-op, and flag order does not matter).
 *
 * Returns the set of seen flags on success, or `null` if any flag was
 * unknown or repeated. The caller maps the returned set to its options
 * object and prints its own subcommand-specific usage line on `null`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @param known The set of accepted flag tokens for this subcommand.
 * @returns The set of flags seen, or `null` on an unknown/duplicate flag.
 */
export function parseFlags(argv: string[], known: Set<string>): Set<string> | null {
  const seen = new Set<string>();
  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i];
    if (!known.has(flag) || seen.has(flag)) {
      return null;
    }
    seen.add(flag);
  }
  return seen;
}

/** Parsed result from {@link parseRedactArgs}. */
export type RedactArgs = {
  /** Validated session id. */
  id: string;
  /** Optional gitleaks rule id filter passed via `--rule <id>`. */
  rule: string | undefined;
  /** True when `--dry-run` was present. */
  dryRun: boolean;
};

/**
 * Argv parser for `nomad redact <session-id> [--rule <rule-id>] [--dry-run]`.
 *
 * Handles a required positional id at argv[3], an optional boolean
 * `--dry-run`, and an optional `--rule <value>` that consumes the next token.
 * Returns `null` on any parse error: missing id, id failing the validation
 * regex, unknown flag, `--rule` with no value or a value that looks like
 * another flag, or a repeated flag.
 *
 * The id regex (`/^\w[\w-]{0,127}$/`) mirrors the `drop-session` arm: the
 * leading `\w` prevents leading-dash ids so `nomad redact --bogus` shows
 * usage rather than passing an invalid id to `cmdRedact`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed redact arguments, or `null` on any parse error.
 */
export function parseRedactArgs(argv: string[]): RedactArgs | null {
  const id = argv[3];
  if (typeof id !== 'string' || !/^\w[\w-]{0,127}$/.test(id)) {
    return null;
  }
  let rule: string | undefined;
  let dryRun = false;
  let sawRule = false;
  let sawDryRun = false;
  let i = 4;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--dry-run') {
      if (sawDryRun) return null;
      sawDryRun = true;
      dryRun = true;
      i++;
    } else if (token === '--rule') {
      if (sawRule) return null;
      sawRule = true;
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) return null;
      rule = val;
      i += 2;
    } else {
      return null;
    }
  }
  return { id, rule, dryRun };
}
