import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { allSharedLinks, CLAUDE_HOME, HOME, REPO_HOME, type PathMap } from './config.ts';

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
  return token
    .replace(/^\$\{HOME\}/, HOME)
    .replace(/^\$HOME/, HOME)
    .replace(/^~/, HOME);
}

/** Strip leading/trailing shell quoting and control punctuation from a token. */
function stripShellPunct(token: string): string {
  return token.replace(/^['"]+/, '').replace(/['"`;)|&>]+$/, '');
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
  const mapPath = join(REPO_HOME, 'path-map.json');
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
    const prefix = `${CLAUDE_HOME}/${name}/`;
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
 * Build a set of character offsets that fall inside comments or string literals.
 * Used to filter require/import specifiers so those inside comments or strings
 * are silently ignored. A single left-to-right alternation pass is used so a
 * `//` inside a string literal (e.g. a URL) is consumed by the string branch
 * rather than mistaken for a line comment.
 *
 * @param src - Raw source text.
 * @returns Set of character indices inside comments or string literals.
 */
function suppressedRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'[^']*'|"[^"]*"|`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Return true when `pos` falls inside any of the suppressed ranges. */
function inSuppressedRange(pos: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

/**
 * Extract top-of-file relative specifiers from source. Only
 * `require('../...')` / `require('./...')` and static `import ... from '../...'`
 * / `'./...'` are captured. Specifiers inside comments or string literals are
 * filtered out via the suppressedRanges check.
 *
 * @param src - Raw source text (not pre-stripped).
 * @returns Array of relative specifier strings.
 */
function topRelativeSpecifiers(src: string): string[] {
  const ranges = suppressedRanges(src);
  const specifiers: string[] = [];
  const reqRe = /\brequire\s*\(\s*(['"])(\.\.?\/[^'"]*)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = reqRe.exec(src)) !== null) {
    if (!inSuppressedRange(m.index, ranges)) specifiers.push(m[2]);
  }
  const impRe = /\bfrom\s+(['"])(\.\.?\/[^'"]*)\1/g;
  while ((m = impRe.exec(src)) !== null) {
    if (!inSuppressedRange(m.index, ranges)) specifiers.push(m[2]);
  }
  return specifiers;
}

/**
 * Resolve a relative specifier against `baseDir` with conservative extension
 * probing. Returns true when the target is missing (WARN) and false when it
 * exists or resolution is uncertain (under-warn rather than noise-warn).
 *
 * @param specifier - Relative specifier, e.g. `../gsd-core/bin/lib/foo.cjs`.
 * @param baseDir - Realpath'd directory of the script.
 * @returns True when the target is provably absent.
 */
function specifierIsMissing(specifier: string, baseDir: string): boolean {
  const base = resolve(baseDir, specifier);
  if (existsSync(base)) return false;
  // Probe common extensions when specifier has no extension
  for (const ext of ['.js', '.cjs', '.mjs']) {
    if (existsSync(base + ext)) return false;
  }
  /* c8 ignore start */
  // Probe index files: defense-in-depth only. A directory at `base` already returns
  // true from existsSync(base) above, so a bare `base/index.*` probe is only
  // reachable when `base` is absent but its children somehow exist -- not a
  // valid filesystem state; kept for conservative under-WARN semantics.
  for (const idx of ['index.js', 'index.cjs', 'index.mjs']) {
    if (existsSync(join(base, idx))) return false;
  }
  /* c8 ignore stop */
  return true;
}

/**
 * Return true when at least one top-of-file relative specifier in `scriptPath`
 * is provably missing from the realpath'd location. Reads a bounded 64 KB
 * prefix (never unbounded), strips comments/strings, and resolves each relative
 * specifier against the realpath dir. Returns false on any fs/read error (skip).
 *
 * @param scriptPath - Absolute, home-expanded script path.
 * @returns True when at least one relative require target is missing.
 */
function relativeRequireTargetsBroken(scriptPath: string): boolean {
  let realPath: string;
  try {
    realPath = realpathSync(scriptPath);
  } catch {
    return false;
  }
  let raw: string;
  /* c8 ignore start */
  // Defensive: realPath resolved above but the file could vanish (race) or be
  // unreadable (permissions). Degrade to skip to preserve the WARN-only contract.
  try {
    const full = readFileSync(realPath, 'utf8');
    raw = full.slice(0, 65536); // 64 KB bound
  } catch {
    return false;
  }
  /* c8 ignore stop */
  const specifiers = topRelativeSpecifiers(raw);
  if (specifiers.length === 0) return false;
  const baseDir = dirname(realPath);
  for (const spec of specifiers) {
    if (specifierIsMissing(spec, baseDir)) return true;
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
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
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
  /* c8 ignore start */
  // JSON.parse('null') returns null; a settings.json containing only 'null' is
  // pathological and cannot reach this branch via the malformed-JSON catch above.
  if (settings === null) return;
  /* c8 ignore stop */

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
