import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME } from './config.ts';

/**
 * WARN-only `nomad doctor` reporter that catches the ESM/CommonJS module-scope
 * footgun on synced `.js` hooks. A `~/.claude/hooks` symlink resolves (via
 * realpath) into the repo tree, where Node inherits the nearest ancestor
 * `package.json` `"type"`, so a `.js` hook can be loaded under the wrong module
 * system and throw at first fire (`require is not defined in ES module scope`,
 * or the reverse). The failure only surfaces when a hook actually fires, never
 * at sync time. This is the static, no-execution detector. For each `.js` hook
 * it compares the source syntax family (CJS vs ESM) against the effective
 * module type (extension wins for `.cjs`/`.mjs`; else the realpath ancestor
 * `package.json` `"type"`, defaulting to CommonJS) and emits one of:
 *   - `⚠︎ hooks/<name>: cjs source loads as esm (...)` on a CJS-as-ESM mismatch
 *   - `⚠︎ hooks/<name>: esm source loads as cjs (...)` on an ESM-as-CJS mismatch
 *   - `✓ hooks: module type consistent` when every `.js` hook is consistent
 *   - `ℹ︎ no ~/.claude/hooks; skipping module-scope check` when the dir is absent
 * The check never sets `process.exitCode` and never throws: any malformed file
 * or broken symlink degrades to a silent skip.
 */

/** Effective module type of a hook: ESM or CommonJS. */
type ModuleType = 'esm' | 'cjs';

/**
 * Read a `package.json` `"type"` and map it to a `ModuleType`. `"module"` is
 * ESM; anything else (`"commonjs"`, absent key, or a malformed/unreadable file)
 * degrades to CJS, which never under-warns the dangerous explicit-module case.
 *
 * @param pkgPath - Absolute path to a `package.json` known to exist.
 * @returns `'esm'` when the type is `"module"`, otherwise `'cjs'`.
 */
function typeFromPackageJson(pkgPath: string): ModuleType {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: unknown };
    return parsed.type === 'module' ? 'esm' : 'cjs';
  } catch {
    return 'cjs';
  }
}

/**
 * Compute the effective module type of a hook, mirroring Node's resolution.
 * `.mjs` wins as ESM and `.cjs` wins as CJS (immune to the ancestor walk). For
 * `.js`, the symlink is resolved to its realpath FIRST, then ancestors are
 * walked from the realpath dir; the FIRST `package.json` found decides (the
 * walk stops there even when it has no `"type"` key). Reaching the filesystem
 * root with no `package.json` defaults to CJS. A broken symlink (realpath throw)
 * returns `null` so the caller silently skips the file.
 *
 * @param hookPath - Absolute path to the hook entry under `~/.claude/hooks`.
 * @returns The effective module type, or `null` to signal a skip.
 */
function effectiveType(hookPath: string): ModuleType | null {
  const ext = extname(hookPath);
  /* c8 ignore start */
  // Defensive extension guard mirroring Node's resolution. The reporter loop
  // already filters to `.js`, so these branches are unreachable via the public
  // API; kept so `effectiveType` is correct in isolation.
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';
  /* c8 ignore stop */
  let real: string;
  try {
    real = realpathSync(hookPath);
  } catch {
    return null;
  }
  let dir = dirname(real);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) return typeFromPackageJson(pkg);
    const parent = dirname(dir);
    if (parent === dir) return 'cjs';
    dir = parent;
  }
}

/**
 * Strip line comments (`//`), block comments, and single/double/backtick string
 * literals from source so the family grep does not trip on the word `import` in
 * a comment or `"export"` in a string. A single left-to-right alternation pass
 * is used so a `//` inside a string literal (e.g. a URL) is consumed by the
 * string branch rather than mistaken for a line comment that swallows the rest
 * of the line. A small regex pass is sufficient for a doctor WARN; full
 * tokenization is overkill, so a stray quote inside a regex literal can still
 * desync the scan (an accepted false-negative: the worst case is a missed hint).
 *
 * @param src - Raw hook source bytes.
 * @returns Source with comments and string/template literals removed.
 */
function stripCommentsAndStrings(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => {
      const open = match[0];
      if (open === "'") return "''";
      if (open === '"') return '""';
      if (open === '`') return '``';
      return ' ';
    },
  );
}

/**
 * Classify hook source as CJS, ESM, or unknown by a comment/string-stripped
 * grep. CJS markers are `require(`, `module.exports`, or `exports.<name>`. ESM
 * markers are line-anchored `import`/`export` statements or `import.meta`;
 * dynamic `import(...)` is legal in CJS and deliberately does NOT count. CJS
 * wins a tie (a file with both is almost always a CJS module with a stray
 * token). No markers at all (a shell script or shebang launcher) is `unknown`,
 * which the caller skips.
 *
 * @param src - Raw hook source bytes.
 * @returns `'cjs'`, `'esm'`, or `'unknown'`.
 */
function classifySource(src: string): ModuleType | 'unknown' {
  const code = stripCommentsAndStrings(src);
  const cjs =
    /\brequire\s*\(/.test(code) || /\bmodule\.exports\b/.test(code) || /\bexports\.\w/.test(code);
  // Leading whitespace uses `[^\S\r\n]` (not `\s`) so `^...` under /m cannot span
  // newlines and backtrack across the file from every line start (super-linear).
  const esm =
    /^[^\S\r\n]*import\s/m.test(code) ||
    /^[^\S\r\n]*export\s/m.test(code) ||
    /\bimport\.meta\b/.test(code);
  if (cjs && !esm) return 'cjs';
  if (esm && !cjs) return 'esm';
  if (cjs && esm) return 'cjs';
  return 'unknown';
}

/**
 * Build the per-file WARN remedy clause for a source/effective-type mismatch.
 * Per-file and topology-neutral: it does NOT assume a `shared/hooks/package.json`
 * shim is already present.
 *
 * @param family - The detected source family that is mismatched.
 * @returns The remedy text shown in parentheses on the WARN row.
 */
function remedy(family: ModuleType): string {
  return family === 'cjs'
    ? 'rename to .cjs, or add { "type": "commonjs" } to the hooks dir'
    : 'rename to .mjs (a synced hooks/ dir treats .js as CommonJS)';
}

/**
 * Tolerantly list a directory's entries, degrading to `[]` on any error so a
 * missing or unreadable hooks dir never throws mid-output.
 *
 * @param dir - Absolute directory path to enumerate.
 * @returns The entry names, or `[]` on error.
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Tolerantly read a file's bytes, degrading to `null` on any error so a hook
 * that vanishes or is unreadable is a silent skip.
 *
 * @param path - Absolute file path to read.
 * @returns The file contents, or `null` on error.
 */
function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Append the module-scope check result to the supplied section. Enumerates
 * `~/.claude/hooks`, and for each `.js` entry compares its realpath-derived
 * effective module type against its source family, emitting a `⚠︎` WARN row on
 * a bidirectional mismatch. `.cjs`/`.mjs` hooks, undecidable sources, and broken
 * symlinks are silently skipped. Emits one `✓` summary line when every `.js`
 * hook is consistent, or a `ℹ︎` info skip when the hooks dir is absent. Never
 * sets `process.exitCode`.
 *
 * @param section - The doctor section to append items to.
 */
export function reportHookScopeCheck(section: DoctorSection): void {
  const hooksDir = join(CLAUDE_HOME, 'hooks');
  if (!existsSync(hooksDir)) {
    addItem(section, `${dim(infoGlyph)} no ~/.claude/hooks; skipping module-scope check`);
    return;
  }

  let anyWarn = false;
  for (const name of safeReaddir(hooksDir)) {
    if (extname(name) !== '.js') continue;
    const abs = join(hooksDir, name);
    const eff = effectiveType(abs);
    if (eff === null) continue;
    const src = safeRead(abs);
    if (src === null) continue;
    const fam = classifySource(src);
    if (fam === 'unknown' || fam === eff) continue;
    addItem(
      section,
      `${yellow(warnGlyph)} hooks/${name}: ${fam} source loads as ${eff} (${remedy(fam)})`,
    );
    anyWarn = true;
  }

  if (!anyWarn) {
    addItem(section, `${green(okGlyph)} hooks: module type consistent`);
  }
}
