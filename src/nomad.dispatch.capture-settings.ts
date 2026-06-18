/**
 * Argv parser for `nomad capture-settings [--host] [--dry-run] [--yes]`.
 *
 * Accepts `--host`, `--dry-run`, and `--yes` (alias `-y`) boolean flags in any
 * order. Returns `null` on any parse error: unknown token, duplicate of any
 * flag, or an extra positional argument.
 */

/** Parsed result from {@link parseCaptureSettingsArgs}. */
export type CaptureSettingsArgs = {
  /** True when `--host` was present (write to hosts/<HOST>.json instead of base). */
  host: boolean;
  /** True when `--dry-run` was present. */
  dryRun: boolean;
  /** True when `--yes`/`-y` was present (skip the confirmation prompt). */
  yes: boolean;
};

/**
 * Argv parser for `nomad capture-settings [--host] [--dry-run] [--yes]`.
 *
 * Loops from index 3 (past `node`, `nomad.ts`, and `capture-settings`).
 * Accepts at most one each of `--host`, `--dry-run`, and `--yes` (alias `-y`)
 * boolean flag; rejects duplicates, unknown tokens, and extra positional
 * arguments by returning `null`.
 *
 * @param argv The full process argv array (parsing starts at index 3).
 * @returns Parsed capture-settings arguments, or `null` on any parse error.
 */
export function parseCaptureSettingsArgs(argv: string[]): CaptureSettingsArgs | null {
  let host = false;
  let dryRun = false;
  let yes = false;
  let i = 3;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--host') {
      if (host) return null;
      host = true;
    } else if (token === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
    } else if (token === '--yes' || token === '-y') {
      if (yes) return null;
      yes = true;
    } else {
      return null;
    }
    i++;
  }
  return { host, dryRun, yes };
}
