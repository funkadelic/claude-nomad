/**
 * Command-substitution scanning for the hook-command classifier. A hook command
 * can open a shell substitution whose body must never be mined for a script
 * token, so `isGsdHookEntry` skips each substitution whole before it decides
 * which token is the script.
 *
 * Two forms are recognized, `$(...)` and backticks, in launcher or argument
 * position, with or without a leading quote.
 */

/**
 * Matches the start of a command-substitution token, `$(` or a backtick, with an
 * optional single leading quote (e.g. `"$(for`, `$(command`, `` `command ``).
 */
const SUB_START = /^['"]?(?:\$\(|`)/;

/**
 * Quoting context inside a `$(...)` substitution. `cmd` is a command context
 * where parentheses are syntax, `dq` a double-quoted run where only a nested
 * `$(` is, and `sq` a single-quoted run where nothing is.
 */
type SubContext = 'cmd' | 'dq' | 'sq';

/** Scanner state, carried across whitespace-split tokens. */
interface SubScan {
  stack: SubContext[];
  depth: number;
  escaped: boolean;
}

/**
 * Returns `true` when a token opens a command substitution.
 *
 * @param token - A single whitespace-delimited command token.
 * @returns `true` if the token starts a `$(...)` or backtick substitution.
 */
export function opensSubstitution(token: string): boolean {
  return SUB_START.test(token);
}

/**
 * Consume one character of a `$(...)` body and return the next index.
 * Parentheses change depth only in a command context, so a literal paren inside
 * quotes (`$(printf "(")`) or after a backslash does not.
 *
 * @param token - The token being scanned.
 * @param i - Index of the character to consume.
 * @param scan - Scanner state, mutated in place.
 * @returns Index of the next character to consume.
 */
function stepChar(token: string, i: number, scan: SubScan): number {
  const c = token[i];
  const top = scan.stack.at(-1);
  if (top === 'sq') {
    if (c === "'") scan.stack.pop();
    return i + 1;
  }
  if (scan.escaped) {
    scan.escaped = false;
    return i + 1;
  }
  if (c === '\\') {
    scan.escaped = true;
    return i + 1;
  }
  // A nested `$(` opens a command context even inside double quotes.
  if (c === '$' && token[i + 1] === '(') {
    scan.stack.push('cmd');
    scan.depth++;
    return i + 2;
  }
  if (c === "'" && top === 'cmd') scan.stack.push('sq');
  else if (c === '"') toggleDoubleQuote(scan, top);
  else if (top === 'cmd') stepParen(c, scan);
  return i + 1;
}

/**
 * Open or close a double-quoted run.
 *
 * @param scan - Scanner state, mutated in place.
 * @param top - Current innermost context.
 */
function toggleDoubleQuote(scan: SubScan, top: SubContext | undefined): void {
  if (top === 'dq') scan.stack.pop();
  else scan.stack.push('dq');
}

/**
 * Apply a parenthesis seen in a command context to the nesting depth.
 *
 * @param c - The character.
 * @param scan - Scanner state, mutated in place.
 */
function stepParen(c: string, scan: SubScan): void {
  if (c === '(') {
    scan.stack.push('cmd');
    scan.depth++;
  } else if (c === ')') {
    scan.stack.pop();
    scan.depth--;
  }
}

/**
 * Skip a `$(...)` substitution whose opener sits in `tokens[start]`. Scans
 * character by character tracking quote and escape state, because the body can
 * both nest a second substitution (`"$(command -v node)"` inside
 * `"$(for ... done)"`) and contain a quoted literal paren that is not syntax.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opens the substitution.
 * @param from - Index of the first body character within `tokens[start]`.
 * @returns Index of the first token after the substitution closes, or `tokens.length` when it never closes.
 */
function skipDollarParen(tokens: string[], start: number, from: number): number {
  const scan: SubScan = { stack: ['cmd'], depth: 1, escaped: false };
  let i = from;
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    while (i < token.length) {
      i = stepChar(token, i, scan);
      if (scan.depth === 0) return j + 1;
    }
    i = 0;
    scan.escaped = false;
  }
  return tokens.length;
}

/**
 * Skip a backtick substitution. Backticks do not nest, so the body ends at the
 * first unescaped backtick; only a backslash escape has to be honored.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opens the substitution.
 * @param from - Index of the first body character within `tokens[start]`.
 * @returns Index of the first token after the closing backtick, or `tokens.length` when it never closes.
 */
function skipBacktick(tokens: string[], start: number, from: number): number {
  let i = from;
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    while (i < token.length) {
      if (token[i] === '\\') i += 2;
      else if (token[i] === '`') return j + 1;
      else i++;
    }
    i = 0;
  }
  return tokens.length;
}

/**
 * Skip the command substitution opening at `tokens[start]` and return the index
 * of the first token after it closes. The opener is whichever of `$(` or a
 * backtick appears first in the token, so a quoted `"$(...)"` and a
 * `` `...` `` are both consumed whole.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opens the substitution (`opensSubstitution` is `true` for it).
 * @returns Index of the first token after the substitution closes, or `tokens.length` when it never closes.
 */
export function skipSubstitution(tokens: string[], start: number): number {
  const token = tokens[start];
  const paren = token.indexOf('$(');
  const tick = token.indexOf('`');
  if (tick >= 0 && (paren < 0 || tick < paren)) return skipBacktick(tokens, start, tick + 1);
  return skipDollarParen(tokens, start, paren + 2);
}
