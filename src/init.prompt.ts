import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { SHARED_LINKS } from './config.ts';
import { log } from './utils.ts';

/**
 * Snapshot-on-init helpers. A plain `nomad init` scaffolds an empty repo, so a
 * first host that already has a rich `~/.claude/` would publish nothing of its
 * own unless the user remembered the `--snapshot` flag. These helpers detect
 * that case and, on an interactive run, offer to seed the repo from the existing
 * config. Pure decision logic lives in `resolveSnapshotChoice` (unit-tested via
 * an injected confirm); the TTY-driving default prompt is isolated below.
 */

/**
 * True when a path exists and carries content worth seeding from: any file, or a
 * directory with at least one entry. An empty directory (which a fresh Claude
 * Code install can leave behind) returns false so a bare `~/.claude/` is not
 * mistaken for real config. Unreadable paths count as absent rather than
 * throwing.
 *
 * @param path - Absolute path to probe.
 * @returns True when the path exists and is a non-empty directory or any file.
 */
function nonEmptyExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (statSync(path).isDirectory()) return readdirSync(path).length > 0;
    return true;
  } catch {
    // existsSync already succeeded, so a stat/readdir throw here is a TOCTOU
    // race or a permission revocation; treat the path as absent rather than
    // aborting init. Defensive and not deterministically reachable in a test.
    /* c8 ignore start */
    return false;
    /* c8 ignore stop */
  }
}

/**
 * True when `~/.claude/` already holds config worth seeding the repo from: a
 * top-level `settings.json`, or any non-empty SHARED_LINKS source (`CLAUDE.md`,
 * `commands/`, `rules/`, `my-statusline.cjs`). A bare or absent `~/.claude/`
 * returns false so a fresh first host is never prompted.
 *
 * @param claudeHome - Absolute path to the user's `~/.claude/` directory.
 * @returns True when existing config is present.
 */
export function hasExistingClaudeConfig(claudeHome: string): boolean {
  if (existsSync(join(claudeHome, 'settings.json'))) return true;
  return SHARED_LINKS.some((name) => nonEmptyExists(join(claudeHome, name)));
}

/* c8 ignore start */
/**
 * Default snapshot confirmation: on an interactive TTY, show the existing-config
 * notice and read a `[Y/n]` answer (defaulting to yes); in a non-interactive
 * shell, print a `--snapshot` tip and return false so the empty-scaffold default
 * is preserved. c8-ignored because it drives real stdin/readline; the
 * accept/decline decision is covered through the injected `confirm` seam in
 * `resolveSnapshotChoice`.
 *
 * @param claudeHome - Absolute path to the user's `~/.claude/` directory.
 * @returns True when the user opts to seed the repo from existing config.
 */
async function confirmSnapshotDefault(claudeHome: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    log(
      `tip: ${claudeHome} already has config; re-run 'nomad init --snapshot' to seed the repo from it.`,
    );
    return false;
  }
  log(`Found existing config in ${claudeHome}.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Seed the new repo from it? [Y/n] ');
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
/* c8 ignore stop */

/**
 * Resolve whether `nomad init` should snapshot the existing `~/.claude/`. The
 * `--snapshot` flag wins outright; otherwise, when existing config is present,
 * defer to `confirm` (the TTY prompt by default). With no existing config the
 * answer is always false (the empty-scaffold path), so a fresh first host is
 * never prompted.
 *
 * @param flagSnapshot - Whether `--snapshot` was passed on the command line.
 * @param claudeHome - Absolute path to the user's `~/.claude/` directory.
 * @param confirm - Confirmation seam; defaults to the TTY-guarded prompt.
 * @returns The effective snapshot decision.
 */
export async function resolveSnapshotChoice(
  flagSnapshot: boolean,
  claudeHome: string,
  confirm: (claudeHome: string) => Promise<boolean> = confirmSnapshotDefault,
): Promise<boolean> {
  if (flagSnapshot) return true;
  if (!hasExistingClaudeConfig(claudeHome)) return false;
  return confirm(claudeHome);
}
