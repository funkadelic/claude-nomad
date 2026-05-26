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
