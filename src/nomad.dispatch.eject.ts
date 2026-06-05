/**
 * Argv parser for `nomad eject [--dry-run]`.
 *
 * `--dry-run` is the only accepted flag. Returns `null` on any parse error:
 * unknown token, duplicate `--dry-run`, or extra positional arguments.
 */

/** Parsed result from {@link parseEjectArgs}. */
export type EjectArgs = {
  /** True when `--dry-run` was present. */
  dryRun: boolean;
};

/**
 * Argv parser for `nomad eject [--dry-run]`.
 *
 * Loops from index 3 (past `node`, `nomad.ts`, and `eject`). Accepts at most
 * one `--dry-run` boolean flag; rejects duplicates, unknown tokens, and extra
 * positional arguments by returning `null`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed eject arguments, or `null` on any parse error.
 */
export function parseEjectArgs(argv: string[]): EjectArgs | null {
  let dryRun = false;
  let i = 3;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
    } else {
      return null;
    }
    i++;
  }
  return { dryRun };
}
