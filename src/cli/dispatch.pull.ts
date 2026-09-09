/**
 * Argv parser for `nomad pull [--dry-run] [--force-remote]`.
 *
 * `--dry-run` and `--force-remote` are mutually exclusive: a dry-run performs
 * no mutations so recovery (which mutates) cannot be combined with it.
 *
 * Returns `null` on any parse error: unknown flag, duplicate, or the
 * `--dry-run` + `--force-remote` combination.
 */

/** Parsed result from {@link parsePullArgs}. */
export type PullArgs = {
  /** True when `--dry-run` was present. */
  dryRun: boolean;
  /** True when `--force-remote` was present. */
  forceRemote: boolean;
};

/**
 * Argv parser for `nomad pull [--dry-run] [--force-remote]`.
 *
 * Loops from index 3, accepts `--dry-run` and `--force-remote` as boolean
 * flags, rejects duplicates and unknown tokens by returning `null`, then
 * rejects the `--dry-run` + `--force-remote` combination (a dry-run mutates
 * nothing; recovery mutates).
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed pull arguments, or `null` on any parse error.
 */
export function parsePullArgs(argv: string[]): PullArgs | null {
  let dryRun = false;
  let forceRemote = false;
  let i = 3;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
    } else if (token === '--force-remote') {
      if (forceRemote) return null;
      forceRemote = true;
    } else {
      return null;
    }
    i++;
  }
  if (dryRun && forceRemote) return null;
  return { dryRun, forceRemote };
}
