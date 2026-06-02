/**
 * Argv parser for `nomad allow <fingerprint> [<fingerprint>...]`.
 *
 * Collects one or more positional fingerprint tokens from `argv[3]` onward.
 * Does not accept flags: any token starting with `-` causes `null` to be
 * returned so the caller can print a usage line (leading-dash guard mirrors
 * the drop-session dispatch arm).
 */

/**
 * Parse one or more positional fingerprint arguments from `argv` (starting at
 * index 3). Returns the array of fingerprint strings when at least one is
 * present and none starts with `-`. Returns `null` when no positionals are
 * given or when any token starts with `-` (so `nomad allow --bogus` shows the
 * usage line rather than being misread as a flag-bearing operation).
 *
 * @param argv The full `process.argv` array (parsing starts at index 3).
 * @returns Array of fingerprint strings, or `null` on parse error.
 */
export function parseAllowArgs(argv: string[]): string[] | null {
  const positionals = argv.slice(3);
  if (positionals.length === 0) return null;
  for (const token of positionals) {
    if (token.startsWith('-')) return null;
  }
  return positionals;
}
