import { applyBool, extractFlagValue, REJECT, type TokenResult } from './nomad.dispatch.helpers.ts';

/** Parsed result from {@link parseCleanArgs}. */
export type CleanArgs = {
  /** True when `--dry-run` was present. */
  dryRun: boolean;
  /** Age duration string from `--older-than <dur>`, or undefined. */
  olderThan: string | undefined;
  /** Snapshot count to retain from `--keep <N>`, or undefined. */
  keep: number | undefined;
};

/** Internal state threaded through the parseCleanArgs loop. */
type CleanParseState = {
  backups: boolean;
  dryRun: boolean;
  olderThan: string | undefined;
  keep: number | undefined;
};

/**
 * Apply the `--older-than <dur>` value flag to the parse state. Rejects a
 * duplicate or a missing value; stores the raw duration string otherwise
 * (the string is validated later by `parseDuration` inside `cmdClean`).
 *
 * @param argv The full process argv array.
 * @param i Index of the `--older-than` token.
 * @param st Mutable parse state.
 * @returns `{ ok, advance }`; advance is 2 on success.
 */
function applyOlderThan(argv: string[], i: number, st: CleanParseState): TokenResult {
  if (st.olderThan !== undefined) return REJECT;
  const val = extractFlagValue(argv, i);
  if (val === null) return REJECT;
  st.olderThan = val;
  return { ok: true, advance: 2 };
}

/**
 * Apply the `--keep <N>` value flag to the parse state. Rejects a duplicate, a
 * missing value, or a value that is not a non-negative integer.
 *
 * @param argv The full process argv array.
 * @param i Index of the `--keep` token.
 * @param st Mutable parse state.
 * @returns `{ ok, advance }`; advance is 2 on success.
 */
function applyKeep(argv: string[], i: number, st: CleanParseState): TokenResult {
  if (st.keep !== undefined) return REJECT;
  const val = extractFlagValue(argv, i);
  // Require a pure base-10 digit run: Number() would coerce '' to 0 (delete all),
  // and accept '1e3'/'0x10'/'3.0'. Reject all of those for a destructive flag.
  if (val === null || !/^\d+$/.test(val)) return REJECT;
  st.keep = Number(val);
  return { ok: true, advance: 2 };
}

/**
 * Apply one token from the clean argv to the parse state. Returns `ok: false`
 * on any error (unknown flag, duplicate, missing or invalid value). `advance`
 * is the index increment to apply on success: 1 for boolean flags, 2 for value
 * flags.
 *
 * @param argv The full process argv array.
 * @param i Index of the token to apply.
 * @param st Mutable parse state accumulated across tokens.
 * @returns `{ ok, advance }` where `ok` is false on a parse error.
 */
function applyCleanToken(argv: string[], i: number, st: CleanParseState): TokenResult {
  switch (argv[i]) {
    case '--backups':
      return applyBool(st.backups, () => (st.backups = true));
    case '--dry-run':
      return applyBool(st.dryRun, () => (st.dryRun = true));
    case '--older-than':
      return applyOlderThan(argv, i, st);
    case '--keep':
      return applyKeep(argv, i, st);
    default:
      return REJECT;
  }
}

/**
 * Argv parser for `nomad clean --backups [--dry-run] [--older-than <dur> |
 * --keep <N>]`.
 *
 * `--backups` is required (the only supported clean target this phase).
 * `--older-than <dur>` and `--keep <N>` are value flags and mutually
 * exclusive; `--keep` must be a non-negative integer. Returns `null` on any
 * parse error: missing `--backups`, unknown flag, duplicate, a value flag with
 * no value, a non-integer `--keep`, or both `--older-than` and `--keep`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed clean arguments, or `null` on any parse error.
 */
export function parseCleanArgs(argv: string[]): CleanArgs | null {
  const st: CleanParseState = {
    backups: false,
    dryRun: false,
    olderThan: undefined,
    keep: undefined,
  };
  let i = 3;
  while (i < argv.length) {
    const { ok, advance } = applyCleanToken(argv, i, st);
    if (!ok) return null;
    i += advance;
  }
  if (!st.backups) return null;
  if (st.olderThan !== undefined && st.keep !== undefined) return null;
  return { dryRun: st.dryRun, olderThan: st.olderThan, keep: st.keep };
}
