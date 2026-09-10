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
 * optional leading double quote (e.g. `"$(for`, `$(command`, `` `command ``).
 *
 * A leading SINGLE quote is deliberately not accepted: single quotes suppress
 * every expansion, so `'$(x)'` is a literal word and not a substitution at all.
 */
const SUB_START = /^"?(?:\$\(|`)/;

/**
 * Quoting context inside a `$(...)` substitution. `cmd` is a command context
 * where parentheses are syntax, `dq` a double-quoted run where only a nested
 * `$(` is, `sq` a single-quoted run where nothing is, and `bt` a nested backtick
 * substitution, which is its own command whose parentheses belong to it.
 */
type SubContext = 'cmd' | 'dq' | 'sq' | 'bt';

/**
 * Where a substitution scan ended.
 *
 * `rest` is the word the substitution left behind, and an empty string means it
 * consumed its tokens whole. Three cases produce a non-empty `rest`:
 * the `$(dirname "$0")/hook.js` idiom, where the script path trails the closing
 * delimiter inside the same token; a bare closing quote; and a substitution that
 * never closed, which reports its own opening token so the caller can fall back
 * to reading that token literally rather than losing the rest of the command.
 */
export interface SubEnd {
  /** Index of the first token after the substitution. */
  next: number;
  /** Text left over at the closing delimiter, or `''` when nothing remains. */
  rest: string;
}

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
  else if (c === '`') toggleBacktick(scan, top);
  else if (c === '"') toggleDoubleQuote(scan, top);
  else if (top === 'cmd') stepParen(c, scan);
  return i + 1;
}

/**
 * Open or close a nested backtick substitution. Its body is a command of its
 * own, so a paren inside it (a `case` arm, say) is not the outer substitution's
 * closer. Without this the outer `$(` closes early and the walk resumes inside
 * the body, where a `gsd-` path would be read as the script.
 *
 * @param scan - Scanner state, mutated in place.
 * @param top - Current innermost context.
 */
function toggleBacktick(scan: SubScan, top: SubContext | undefined): void {
  if (top === 'bt') scan.stack.pop();
  else scan.stack.push('bt');
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
 * @returns Where the substitution ended; `rest` carries the opening token when it never closes.
 */
function skipDollarParen(tokens: string[], start: number, from: number): SubEnd {
  const scan: SubScan = { stack: ['cmd'], depth: 1, escaped: false };
  let i = from;
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    while (i < token.length) {
      i = stepChar(token, i, scan);
      if (scan.depth === 0) return { next: j + 1, rest: token.slice(i) };
    }
    i = 0;
    // The whitespace tokenizer already destroyed whatever a trailing backslash
    // escaped, so escape state deliberately does not survive a token boundary.
    scan.escaped = false;
  }
  return unterminated(tokens, start);
}

/**
 * Skip a backtick substitution. Backticks do not nest, so the body ends at the
 * first unescaped backtick; only a backslash escape has to be honored.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opens the substitution.
 * @param from - Index of the first body character within `tokens[start]`.
 * @returns Where the substitution ended; `rest` carries the opening token when it never closes.
 */
function skipBacktick(tokens: string[], start: number, from: number): SubEnd {
  let i = from;
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    while (i < token.length) {
      if (token[i] === '\\') i += 2;
      else if (token[i] === '`') return { next: j + 1, rest: token.slice(i + 1) };
      else i++;
    }
    // A trailing backslash overshoots past the end here, which drops escape
    // state at the token boundary the same way `skipDollarParen` does above.
    i = 0;
  }
  return unterminated(tokens, start);
}

/**
 * Result for a substitution that never closed: report the opening token as the
 * leftover word. The command is unparseable as shell, so the caller reads that
 * token literally instead of discarding every token after it (which would drop
 * the script path and, for a real gsd hook, delete it on the next pull).
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opened the substitution.
 * @returns A `SubEnd` pointing one past `start` with that token as `rest`.
 */
function unterminated(tokens: string[], start: number): SubEnd {
  return { next: start + 1, rest: tokens[start] };
}

/**
 * Skip the command substitution opening at `tokens[start]` and return the index
 * of the first token after it closes. The opener is whichever of `$(` or a
 * backtick appears first in the token, so a quoted `"$(...)"` and a
 * `` `...` `` are both consumed whole.
 *
 * @param tokens - The whitespace-split command tokens.
 * @param start - Index of the token that opens the substitution (`opensSubstitution` is `true` for it).
 * @returns Where the substitution ended, per `SubEnd`.
 */
export function skipSubstitution(tokens: string[], start: number): SubEnd {
  const token = tokens[start] ?? '';
  const paren = token.indexOf('$(');
  const tick = token.indexOf('`');
  // Neither opener present: the precondition was not met, so consume nothing
  // beyond the token itself rather than scanning it as a substitution body.
  if (paren < 0 && tick < 0) return { next: start + 1, rest: token };
  if (tick >= 0 && (paren < 0 || tick < paren)) return skipBacktick(tokens, start, tick + 1);
  return skipDollarParen(tokens, start, paren + 2);
}
