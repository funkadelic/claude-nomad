import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Build a set of character offsets that fall inside comments or string literals.
 * Used to filter require/import specifiers so those inside comments or strings
 * are silently ignored. A single left-to-right alternation pass is used so a
 * `//` inside a string literal (e.g. a URL) is consumed by the string branch
 * rather than mistaken for a line comment.
 *
 * NOTE: Backslash-escaped quotes within string literals (e.g. `'it\'s ok'`) are
 * not handled; the range may be truncated at the escaped quote. The effect is a
 * false negative (a broken require after the malformed range is missed), never
 * a false positive. This is intentional: the check is conservative and
 * under-warns rather than noise-warns.
 *
 * @param src - Raw source text.
 * @returns Array of [start, end) character index pairs inside comments or literals.
 */
export function suppressedRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'[^']*'|"[^"]*"|`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Return true when `pos` falls inside any of the suppressed ranges. */
export function inSuppressedRange(pos: number, ranges: [number, number][]): boolean {
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
export function topRelativeSpecifiers(src: string): string[] {
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
export function specifierIsMissing(specifier: string, baseDir: string): boolean {
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
export function relativeRequireTargetsBroken(scriptPath: string): boolean {
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
    // Fixed-size read so a huge hook file never loads fully into memory.
    const fd = openSync(realPath, 'r');
    try {
      const buf = Buffer.alloc(65536); // 64 KB bound
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      raw = buf.toString('utf8', 0, bytesRead);
    } finally {
      closeSync(fd);
    }
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
