import { extractFlagValue } from './nomad.dispatch.ts';

/** Parsed result from {@link parsePushArgs}. */
export type PushArgs = {
  /** True when `--dry-run` was present. */
  dryRun: boolean;
  /** True when `--redact-all` was present. */
  redactAll: boolean;
  /** True when `--allow-all` was present. */
  allowAll: boolean;
  /** Rule id from `--allow <rule>`, or undefined. */
  allowRule: string | undefined;
};

/** Internal state threaded through the parsePushArgs loop. */
type PushParseState = {
  dryRun: boolean;
  redactAll: boolean;
  allowAll: boolean;
  allowRule: string | undefined;
};

/** Outcome of applying a single argv token: parse-ok plus the index increment. */
type TokenResult = { ok: boolean; advance: number };

/** Shorthand failure result (no advance). */
const REJECT: TokenResult = { ok: false, advance: 0 };

/**
 * Apply a boolean flag to the parse state. Rejects a duplicate.
 *
 * @param seen Whether the flag was already seen.
 * @param set Setter that marks the flag present in the state.
 * @returns `{ ok, advance }`; advance is 1 on success.
 */
function applyBool(seen: boolean, set: () => void): TokenResult {
  if (seen) return REJECT;
  set();
  return { ok: true, advance: 1 };
}

/**
 * Apply the `--allow <rule>` value flag to the parse state. Rejects a
 * duplicate or a missing/flag-shaped value.
 *
 * @param argv The full process argv array.
 * @param i Index of the `--allow` token.
 * @param st Mutable parse state.
 * @returns `{ ok, advance }`; advance is 2 on success.
 */
function applyAllow(argv: string[], i: number, st: PushParseState): TokenResult {
  if (st.allowRule !== undefined) return REJECT;
  const val = extractFlagValue(argv, i);
  if (val === null) return REJECT;
  st.allowRule = val;
  return { ok: true, advance: 2 };
}

/**
 * Apply one token from the push argv to the parse state. Returns `ok: false`
 * on any error (unknown flag, duplicate, missing or invalid value).
 *
 * @param argv The full process argv array.
 * @param i Index of the token to apply.
 * @param st Mutable parse state accumulated across tokens.
 * @returns `{ ok, advance }` where `ok` is false on a parse error.
 */
function applyPushToken(argv: string[], i: number, st: PushParseState): TokenResult {
  switch (argv[i]) {
    case '--dry-run':
      return applyBool(st.dryRun, () => (st.dryRun = true));
    case '--redact-all':
      return applyBool(st.redactAll, () => (st.redactAll = true));
    case '--allow-all':
      return applyBool(st.allowAll, () => (st.allowAll = true));
    case '--allow':
      return applyAllow(argv, i, st);
    default:
      return REJECT;
  }
}

/**
 * Argv parser for `nomad push [--dry-run] [--redact-all] [--allow <rule>]
 * [--allow-all]`.
 *
 * `--redact-all`, `--allow-all`, and `--allow <rule>` are mutually exclusive
 * resolution modes. Combining any two of them is a parse error. Combining
 * `--allow-all` or `--allow <rule>` with `--dry-run` is also a parse error
 * because a dry-run performs no mutations and cannot resolve anything.
 *
 * Returns `null` on any parse error: unknown flag, duplicate, a value flag
 * with no value or a value that starts with `--`, or a mutually-exclusive
 * combination.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed push arguments, or `null` on any parse error.
 */
export function parsePushArgs(argv: string[]): PushArgs | null {
  const st: PushParseState = {
    dryRun: false,
    redactAll: false,
    allowAll: false,
    allowRule: undefined,
  };
  let i = 3;
  while (i < argv.length) {
    const { ok, advance } = applyPushToken(argv, i, st);
    if (!ok) return null;
    i += advance;
  }
  const hasAllow = st.allowAll || st.allowRule !== undefined;
  // Mutual exclusivity: resolution modes conflict with each other.
  if (st.redactAll && hasAllow) return null;
  if (st.allowAll && st.allowRule !== undefined) return null;
  // --allow* with --dry-run: a dry-run resolves nothing, so this combination
  // is meaningless and rejected as a usage error.
  if (st.dryRun && hasAllow) return null;
  return {
    dryRun: st.dryRun,
    redactAll: st.redactAll,
    allowAll: st.allowAll,
    allowRule: st.allowRule,
  };
}
