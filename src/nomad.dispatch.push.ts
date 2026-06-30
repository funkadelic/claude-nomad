import { applyBool, extractFlagValue, REJECT, type TokenResult } from './nomad.dispatch.helpers.ts';

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
  /** True when `--full-scan` was present. */
  fullScan: boolean;
};

/** Internal state threaded through the parsePushArgs loop. */
type PushParseState = {
  dryRun: boolean;
  redactAll: boolean;
  allowAll: boolean;
  allowRule: string | undefined;
  fullScan: boolean;
};

/**
 * Gitleaks rule-id shape: a leading word character (`\w`, i.e. alphanumeric or
 * underscore) then any of word character or hyphen. Anchoring the first
 * character to a non-hyphen rejects leading-dash values (e.g. `-x`) the way the
 * drop-session and redact arms reject leading-dash positionals, while still
 * accepting real rule ids like `generic-api-key`.
 */
const RULE_ID_RE = /^\w[\w-]*$/;

/**
 * Apply the `--allow <rule>` value flag to the parse state. Rejects a
 * duplicate, a missing/flag-shaped value, or a value that is not a
 * well-formed gitleaks rule id (see {@link RULE_ID_RE}).
 *
 * @param argv The full process argv array.
 * @param i Index of the `--allow` token.
 * @param st Mutable parse state.
 * @returns `{ ok, advance }`; advance is 2 on success.
 */
function applyAllow(argv: string[], i: number, st: PushParseState): TokenResult {
  if (st.allowRule !== undefined) return REJECT;
  const val = extractFlagValue(argv, i);
  if (val === null || !RULE_ID_RE.test(val)) return REJECT;
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
    case '--full-scan':
      return applyBool(st.fullScan, () => (st.fullScan = true));
    default:
      return REJECT;
  }
}

/**
 * Argv parser for `nomad push [--dry-run] [--full-scan] [--redact-all]
 * [--allow <rule>] [--allow-all]`.
 *
 * `--redact-all`, `--allow-all`, and `--allow <rule>` are mutually exclusive
 * resolution modes. Combining any two of them is a parse error. Combining ANY
 * resolution mode (including `--redact-all`) with `--dry-run` is also a parse
 * error because a dry-run performs no mutations and cannot resolve anything.
 *
 * Returns `null` on any parse error: unknown flag, duplicate, a value flag
 * with no value or a non-rule-id value, or a mutually-exclusive combination.
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
    fullScan: false,
  };
  let i = 3;
  while (i < argv.length) {
    const { ok, advance } = applyPushToken(argv, i, st);
    if (!ok) return null;
    i += advance;
  }
  const hasAllow = st.allowAll || st.allowRule !== undefined;
  const wantsResolution = st.redactAll || hasAllow;
  // Mutual exclusivity: resolution modes conflict with each other.
  if (st.redactAll && hasAllow) return null;
  if (st.allowAll && st.allowRule !== undefined) return null;
  // Any resolution mode with --dry-run: a dry-run resolves nothing, so the
  // combination is meaningless and rejected as a usage error.
  if (st.dryRun && wantsResolution) return null;
  return {
    dryRun: st.dryRun,
    redactAll: st.redactAll,
    allowAll: st.allowAll,
    allowRule: st.allowRule,
    fullScan: st.fullScan,
  };
}
