/**
 * Shared primitives for the argv token-machine parsers (`parseInitArgs`,
 * `parsePushArgs`, `parseCleanArgs`, ...). Centralized here so the
 * `TokenResult` shape, the `REJECT` shorthand, the boolean-flag applier, and
 * the `--flag <value>` extractor have one definition instead of being
 * copy-pasted across per-command dispatch modules.
 */

/** Outcome of applying a single argv token: parse-ok plus the index increment. */
export type TokenResult = { ok: boolean; advance: number };

/** Shorthand failure result (no advance). */
export const REJECT: TokenResult = { ok: false, advance: 0 };

/**
 * Apply a boolean flag to the parse state. Rejects a duplicate.
 *
 * @param seen Whether the flag was already seen.
 * @param set Setter that marks the flag present in the state.
 * @returns `{ ok, advance }`; advance is 1 on success.
 */
export function applyBool(seen: boolean, set: () => void): TokenResult {
  if (seen) return REJECT;
  set();
  return { ok: true, advance: 1 };
}

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
