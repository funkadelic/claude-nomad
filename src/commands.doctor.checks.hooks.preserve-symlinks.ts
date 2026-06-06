import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { relativeRequireTargetsBroken } from './commands.doctor.checks.hooks.preserve-symlinks.probe.ts';
import { allSharedLinks, claudeHome, home, repoHome, type PathMap } from './config.ts';

/**
 * WARN-only `nomad doctor` reporter that catches the symlink-broken-relative-require
 * footgun in synced hooks. When a hook command runs `node <script>` where the
 * script lives under a nomad-symlinked `SHARED_LINKS` directory (e.g.
 * `~/.claude/hooks/...`) without `--preserve-symlinks-main`, Node realpaths the
 * main module into the sync repo tree. The script's top-of-file relative
 * `require('../...')`/`import ... from '../...'` then resolves against the repo
 * tree instead of `~/.claude/`, crashing MODULE_NOT_FOUND on first fire.
 *
 * The check is conservative: it only WARNs on the clear `node <path>` shape AND
 * when at least one top-of-file relative specifier is provably missing from the
 * realpath'd location. Self-contained hooks (bare-specifier only, or all relative
 * targets exist) remain silent. Never sets the exit code, never throws.
 */

/** Home-expand `~`, `$HOME`, `${HOME}` in a path token. */
function expandHome(token: string): string {
  const h = home();
  return token
    .replace(/^\$\{HOME\}/, h)
    .replace(/^\$HOME/, h)
    .replace(/^~/, h);
}

/** Strip leading/trailing shell quoting and control punctuation from a token. */
function stripShellPunct(token: string): string {
  const head = token.replace(/^['"]+/, '');
  let end = head.length;
  while (end > 0 && '\'"`;)|&>'.includes(head[end - 1])) end--;
  return head.slice(0, end);
}

/**
 * Split a command on `&&`, `||`, `;`, `|` and return all whitespace-separated
 * tokens from all segments, each home-expanded and shell-punctuation-stripped.
 *
 * @param command - The raw hook command string.
 * @returns Flat array of cleaned tokens.
 */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    for (const raw of seg.trim().split(/\s+/).filter(Boolean)) {
      tokens.push(expandHome(stripShellPunct(raw)));
    }
  }
  return tokens;
}

/**
 * Read path-map.json tolerantly (mirrors the guard in `cmdDoctor`). Returns
 * `{ projects: {} }` when the file is absent or malformed.
 *
 * @returns Parsed PathMap or the safe default.
 */
function readPathMapSafe(): PathMap {
  const mapPath = join(repoHome(), 'path-map.json');
  if (!existsSync(mapPath)) return { projects: {} };
  try {
    return JSON.parse(readFileSync(mapPath, 'utf8')) as PathMap;
  } catch {
    return { projects: {} };
  }
}

/**
 * Return true when `scriptPath` resolves to a location under one of the
 * nomad-symlinked SHARED_LINKS dirs inside CLAUDE_HOME.
 *
 * @param scriptPath - Home-expanded, shell-stripped script path.
 * @param sharedLinkNames - Names from `allSharedLinks(map)`.
 * @returns True when the script resolves under a nomad-managed symlink.
 */
function resolvesUnderSymlinkedShared(scriptPath: string, sharedLinkNames: string[]): boolean {
  for (const name of sharedLinkNames) {
    const prefix = `${claudeHome()}/${name}/`;
    if (scriptPath.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Inspect the node arg list: find the first token that is a `.js` or `.cjs`
 * script path (skipping leading `--flag` / `-x` tokens and `node` itself).
 * Returns the expanded script path or null when none is found.
 *
 * @param tokens - All tokens from one shell segment, starting at or before `node`.
 * @param nodeIdx - Index of the `node` token in the array.
 * @returns The first script token, or null.
 */
function nodeScriptArg(tokens: string[], nodeIdx: number): string | null {
  for (let i = nodeIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) continue;
    if (t.endsWith('.js') || t.endsWith('.cjs')) return t;
    break; // non-flag, non-script token: stop looking
  }
  return null;
}

/**
 * Return true when `--preserve-symlinks-main` appears anywhere in the node
 * argument list starting after `nodeIdx`.
 *
 * @param tokens - All command tokens.
 * @param nodeIdx - Index of the `node` token.
 * @returns True when the flag is present.
 */
function hasPreserveSymlinksMain(tokens: string[], nodeIdx: number): boolean {
  for (let i = nodeIdx + 1; i < tokens.length; i++) {
    if (tokens[i] === '--preserve-symlinks-main') return true;
    if (!tokens[i].startsWith('-')) break; // past the flags
  }
  return false;
}

/**
 * Yield command strings from a flat-format entry list.
 *
 * @param entries - Array of flat hook entries to walk.
 */
function* commandsFromFlatEntries(entries: unknown[]): Iterable<string> {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.type === 'command' && typeof e.command === 'string') yield e.command;
  }
}

/**
 * Yield command strings from a single hook group (flat or grouped shape).
 *
 * @param group - One element of a hooks event array.
 */
function* commandsFromOneGroup(group: unknown): Iterable<string> {
  if (typeof group !== 'object' || group === null) return;
  const g = group as Record<string, unknown>;
  if (Array.isArray(g.hooks)) {
    yield* commandsFromFlatEntries(g.hooks);
    return;
  }
  if (g.type === 'command' && typeof g.command === 'string') yield g.command;
}

/**
 * Return true when the command contains a `node <script.js/.cjs>` invocation
 * whose script resolves under a nomad-symlinked shared-links dir, without
 * `--preserve-symlinks-main`, AND the script has at least one top-of-file
 * relative require whose target is missing from the realpath'd location.
 *
 * NOTE: Only the first `node` token in the flattened token array is inspected.
 * Compound commands with multiple node invocations may produce a false negative
 * on the second invocation. This is consistent with the conservative under-warn
 * design.
 *
 * @param command - The raw hook command string.
 * @param sharedLinkNames - Names from `allSharedLinks(map)`.
 * @returns The script path when flagged, or null when not flagged.
 */
function flaggedScript(command: string, sharedLinkNames: string[]): string | null {
  const tokens = commandTokens(command);
  const nodeIdx = tokens.indexOf('node');
  if (nodeIdx < 0) return null;
  if (hasPreserveSymlinksMain(tokens, nodeIdx)) return null;
  const script = nodeScriptArg(tokens, nodeIdx);
  if (script === null) return null;
  if (!resolvesUnderSymlinkedShared(script, sharedLinkNames)) return null;
  if (!relativeRequireTargetsBroken(script)) return null;
  return script;
}

/**
 * Walk a single hook event's group list and emit WARN items for any flagged
 * commands. Returns true when at least one WARN was emitted.
 *
 * @param section - Doctor section to append items to.
 * @param event - Hook event name (e.g. `PostToolUse`).
 * @param groups - Array of hook groups for this event.
 * @param sharedLinkNames - Names from `allSharedLinks(map)`.
 * @returns True when any WARN was emitted.
 */
function checkEventForPreserveSymlinks(
  section: DoctorSection,
  event: string,
  groups: unknown[],
  sharedLinkNames: string[],
): boolean {
  let anyWarn = false;
  for (const group of groups) {
    for (const cmd of commandsFromOneGroup(group)) {
      const script = flaggedScript(cmd, sharedLinkNames);
      if (script === null) continue;
      addItem(
        section,
        `${yellow(warnGlyph)} hooks/${event}: node ${script} needs --preserve-symlinks-main` +
          ` (add it to the hook command in shared/settings.base.json)`,
      );
      anyWarn = true;
    }
  }
  return anyWarn;
}

/**
 * Append the preserve-symlinks-main check result to the supplied section. Reads
 * `~/.claude/settings.json`, walks every hook command, and emits a `⚠︎` WARN for
 * each `node <script-under-symlinked-dir>` invocation missing
 * `--preserve-symlinks-main` whose top-of-file relative require is provably
 * broken. Never sets the exit code. Emits a `✓` summary when no issue is
 * found, or `ℹ︎` skip when `settings.json` is absent.
 *
 * @param section - The doctor section to append items to.
 */
export function reportPreserveSymlinksCheck(section: DoctorSection): void {
  const settingsPath = join(claudeHome(), 'settings.json');
  if (!existsSync(settingsPath)) {
    addItem(
      section,
      `${dim(infoGlyph)} no ~/.claude/settings.json; skipping preserve-symlinks-main check`,
    );
    return;
  }

  // Use a tolerant parse that degrades to null without elevating to FAIL,
  // since this is a WARN-only reporter. readJsonSafe would set exitCode=1 on
  // malformed JSON, which is not appropriate here -- parse inline instead.
  let settings: Record<string, unknown> | null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return; // malformed JSON -> silent skip, no exit code mutation
  }
  if (settings === null) return; // settings.json containing only `null` is valid JSON

  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    addItem(section, `${green(okGlyph)} hooks: preserve-symlinks-main not needed`);
    return;
  }

  const map = readPathMapSafe();
  const sharedLinkNames = allSharedLinks(map);
  let anyWarn = false;

  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    if (checkEventForPreserveSymlinks(section, event, groups, sharedLinkNames)) anyWarn = true;
  }

  if (!anyWarn) {
    addItem(section, `${green(okGlyph)} hooks: preserve-symlinks-main not needed`);
  }
}
