import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { dim, failGlyph, green, infoGlyph, okGlyph, red } from './color.ts';
import { addItem, readJsonSafe, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME, HOME } from './config.ts';

/**
 * Always-on `nomad doctor` reporter. Reads `~/.claude/settings.json`, walks
 * every `{ type: "command", command }` entry in the `hooks` block, and FAILs
 * with `process.exitCode = 1` for each command token that confidently resolves
 * to a path under `~/.claude` but is missing on disk. Commands with no
 * resolvable `~/.claude` path (bare binaries, unresolved env vars) are silently
 * skipped per D-09: the check only surfaces the issue-#170 case of synced hook
 * config pointing at unsynced local scripts.
 */

/**
 * Candidate token prefix patterns that indicate a path under `~/.claude`.
 * The first entry is the resolved absolute prefix (e.g. `/home/norm/.claude/`,
 * identical to `CLAUDE_HOME + '/'` since `CLAUDE_HOME = resolve(HOME, '.claude')`);
 * the rest are the literal unexpanded forms a hook command may use.
 */
const CLAUDE_HOME_PREFIXES = [
  `${HOME}/.claude/`,
  '~/.claude/',
  '$HOME/.claude/',
  '${HOME}/.claude/',
] as const;

/**
 * Expand `~` and `$HOME`/`${HOME}` to the resolved HOME directory so the
 * resulting path can be passed to `existsSync`.
 *
 * @param token - A raw path token extracted from a hook command string.
 * @returns The absolute path with the home prefix resolved.
 */
function expandHome(token: string): string {
  return token
    .replace(/^\$\{HOME\}/, HOME)
    .replace(/^\$HOME/, HOME)
    .replace(/^~/, HOME);
}

/**
 * Strip shell quoting and trailing control punctuation from a raw command
 * token so a real path is not mistaken for a missing one. Without this, a
 * quoted compound command like `bash -c 'a.sh; ~/.claude/hooks/run.sh'` yields
 * the token `~/.claude/hooks/run.sh'` (trailing quote), and `existsSync` would
 * FAIL on a script that is actually present (a D-09 false-FAIL). Removes
 * leading quotes and any trailing run of `'"`;)|&>` characters. A genuine path
 * never carries these on its boundary, so stripping them is safe.
 *
 * @param token - A raw whitespace-delimited token from a command segment.
 * @returns The token with boundary shell punctuation removed.
 */
function stripShellPunctuation(token: string): string {
  return token.replace(/^['"]+/, '').replace(/['"`;)|&>]+$/, '');
}

/**
 * Extract the first whitespace-delimited token from `command` that begins with
 * a recognisable `~/.claude` prefix. Also checks `&&`-, `;`-, and `|`-separated
 * sub-commands so compound commands like `setup.sh && jq ...` are handled, and
 * strips shell quoting so a quoted target is not read as missing.
 * Returns `null` when no such token is found (D-09: skip, never FAIL).
 *
 * @param command - The raw `command` string from a hook entry.
 * @returns The absolute resolved path, or `null` if none is resolvable.
 */
function resolveClaudePath(command: string): string | null {
  const segments = command.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const raw = segment.trim().split(/\s+/)[0] ?? '';
    const token = stripShellPunctuation(raw);
    if (CLAUDE_HOME_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      return expandHome(token);
    }
  }
  return null;
}

/**
 * A hook entry in flat format: `{ type: "command"; command: string }`.
 * Used internally by `commandsFromFlat` to narrow the parsed JSON shape.
 */
type FlatEntry = { type: unknown; command?: unknown };

/**
 * Yield command strings from a flat-format entry list (each element is
 * directly `{ type: "command", command: string }`). Skips non-object and
 * non-command entries silently (T-25-07 defence).
 *
 * @param entries - Array of flat hook entries to walk.
 */
function* commandsFromFlat(entries: unknown[]): Iterable<string> {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as FlatEntry;
    if (e.type === 'command' && typeof e.command === 'string') yield e.command;
  }
}

/**
 * Yield every `{ type: "command"; command: string }` entry from a single
 * hook group, which may be a flat array entry or a grouped object with a
 * nested `hooks` array. Non-object / non-command entries are silently skipped
 * (D-09 / T-25-07 defence: malformed input degrades to skips, never throws).
 *
 * @param group - One element of a hooks event array.
 * @returns Iterable of command strings from command-type entries.
 */
function* commandsFromGroup(group: unknown): Iterable<string> {
  if (typeof group !== 'object' || group === null) return;
  const g = group as Record<string, unknown>;
  // Grouped shape: { matcher?, hooks: HookEntry[] }
  if (Array.isArray(g.hooks)) {
    yield* commandsFromFlat(g.hooks);
    return;
  }
  // Flat shape: the group itself is { type: "command", command: string }
  if (g.type === 'command' && typeof g.command === 'string') yield g.command;
}

/**
 * Walk all hook groups for a single event and emit FAIL items for every
 * resolved-but-missing `~/.claude` target. Returns true when at least one
 * FAIL was emitted (used by the caller to suppress the OK summary line).
 *
 * @param section - Doctor section to append items to.
 * @param event - Hook event name (e.g. `PostToolUse`).
 * @param groups - Array of hook groups for this event.
 * @returns True when any missing target was found.
 */
function checkEventGroups(section: DoctorSection, event: string, groups: unknown[]): boolean {
  let anyFail = false;
  for (const group of groups) {
    for (const cmd of commandsFromGroup(group)) {
      const resolved = resolveClaudePath(cmd);
      if (resolved === null) continue;
      if (!existsSync(resolved)) {
        addItem(section, `${red(failGlyph)} hooks/${event}: command target missing: ${resolved}`);
        process.exitCode = 1;
        anyFail = true;
      }
    }
  }
  return anyFail;
}

/**
 * Append the Hook-targets check result to the supplied section. Reads
 * `~/.claude/settings.json`, walks every command entry in the `hooks` block,
 * and emits a `✗` FAIL for each `~/.claude` target that is absent on disk.
 * Commands with no resolvable local path are silently skipped (D-09).
 * Emits a `✓` OK line when all resolvable targets exist (or none were found).
 * Emits a `ℹ︎` info skip when `settings.json` is absent.
 *
 * @param section - The doctor section to append items to.
 */
export function reportHooksTargetCheck(section: DoctorSection): void {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) {
    addItem(section, `${dim(infoGlyph)} no ~/.claude/settings.json; skipping hook target check`);
    return;
  }

  const settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath, section);
  if (settings === null) return;

  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    addItem(section, `${green(okGlyph)} hooks: all command targets present`);
    return;
  }

  let anyFail = false;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    if (checkEventGroups(section, event, groups)) anyFail = true;
  }

  if (!anyFail) {
    addItem(section, `${green(okGlyph)} hooks: all command targets present`);
  }
}
