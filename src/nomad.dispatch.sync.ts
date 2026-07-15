/**
 * Argv parser for `nomad sync [--dry-run] [--verbose|--all|-v]`.
 *
 * `--dry-run` and the verbosity flags are the only accepted tokens; sync
 * deliberately does not accept `--force-remote` (wedge recovery stays on the
 * explicit `nomad pull --force-remote` command) or any of the push resolution
 * flags (`--redact-all`, `--allow`, `--allow-all`, `--full-scan`). Advanced
 * cases route to the low-level `push`/`pull` commands.
 *
 * Returns `null` on any parse error: unknown flag, duplicate `--dry-run`, or
 * extra positional arguments.
 */

/** Parsed result from {@link parseSyncArgs}. */
export type SyncArgs = {
  /** True when `--dry-run` was present. */
  dryRun: boolean;
  /** True when `--verbose`, `--all`, or `-v` was present. */
  verbose: boolean;
};

/**
 * Argv parser for `nomad sync [--dry-run] [--verbose|--all|-v]`.
 *
 * Loops from index 3 (past `node`, `nomad.ts`, and `sync`). Accepts at most
 * one `--dry-run` boolean flag plus any of the three verbosity tokens
 * (`--verbose`/`--all`/`-v`, mirroring `parseDoctorArgs`'s verbosity
 * handling); rejects duplicate `--dry-run`, unknown tokens, and extra
 * positional arguments by returning `null`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed sync arguments, or `null` on any parse error.
 */
export function parseSyncArgs(argv: string[]): SyncArgs | null {
  let dryRun = false;
  let verbose = false;
  let i = 3;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
    } else if (token === '--verbose' || token === '--all' || token === '-v') {
      verbose = true;
    } else {
      return null;
    }
    i++;
  }
  return { dryRun, verbose };
}
