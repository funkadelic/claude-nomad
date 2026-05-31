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

/** Parsed result from {@link parseInitArgs}. */
export type InitArgs = {
  /** True when `--snapshot` was present. */
  snapshot: boolean;
  /** True when `--keep-actions` was present. */
  keepActions: boolean;
  /** Optional repo name supplied via `--repo <name>`. */
  repoName: string | undefined;
};

/**
 * Extract the value following a `--flag <value>` pair. Returns the value
 * string on success, or `null` when the next token is missing or starts with
 * `--` (which would indicate the flag was supplied without a value).
 *
 * @param argv The full process argv array.
 * @param i Index of the flag token; the value is read from `i + 1`.
 * @returns The value token, or `null` when absent or itself a `--` flag.
 */
export function extractFlagValue(argv: string[], i: number): string | null {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('--')) return null;
  return val;
}

/** Internal state threaded through the parseInitArgs loop. */
type InitParseState = {
  snapshot: boolean;
  keepActions: boolean;
  repoName: string | undefined;
  sawSnapshot: boolean;
  sawKeepActions: boolean;
  sawRepo: boolean;
};

/**
 * Apply one token from the init argv to the parse state. Returns `true` on
 * success or `false` when the token is invalid (unknown flag, duplicate, or
 * `--repo` with no valid value). Advances `i` by mutation via the returned
 * increment: 1 for boolean flags, 2 for `--repo <value>`.
 */
function applyInitToken(
  argv: string[],
  i: number,
  st: InitParseState,
): { ok: boolean; advance: number } {
  const token = argv[i];
  if (token === '--snapshot') {
    if (st.sawSnapshot) return { ok: false, advance: 0 };
    st.sawSnapshot = true;
    st.snapshot = true;
    return { ok: true, advance: 1 };
  }
  if (token === '--keep-actions') {
    if (st.sawKeepActions) return { ok: false, advance: 0 };
    st.sawKeepActions = true;
    st.keepActions = true;
    return { ok: true, advance: 1 };
  }
  if (token === '--repo') {
    if (st.sawRepo) return { ok: false, advance: 0 };
    st.sawRepo = true;
    const val = extractFlagValue(argv, i);
    if (val === null) return { ok: false, advance: 0 };
    st.repoName = val;
    return { ok: true, advance: 2 };
  }
  return { ok: false, advance: 0 };
}

/**
 * Argv parser for `nomad init [--snapshot] [--keep-actions] [--repo <name>]`.
 *
 * Handles boolean `--snapshot` and `--keep-actions` flags plus an optional
 * value-bearing `--repo <name>`. Returns `null` on any parse error: unknown
 * flag, duplicate flag, `--repo` with no value, or `--repo` whose value
 * starts with `--`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed init arguments, or `null` on any parse error.
 */
export function parseInitArgs(argv: string[]): InitArgs | null {
  const st: InitParseState = {
    snapshot: false,
    keepActions: false,
    repoName: undefined,
    sawSnapshot: false,
    sawKeepActions: false,
    sawRepo: false,
  };
  let i = 3;
  while (i < argv.length) {
    const { ok, advance } = applyInitToken(argv, i, st);
    if (!ok) return null;
    i += advance;
  }
  return { snapshot: st.snapshot, keepActions: st.keepActions, repoName: st.repoName };
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
