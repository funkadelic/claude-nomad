import { diffLines } from 'diff';

import { green, red } from './color.ts';

/**
 * Map a jsdiff `diffLines` result for two pre-stringified JSON strings into
 * an array of unified-diff body lines (the two-line header is the caller's
 * responsibility).
 *
 * Each jsdiff part has a `value` that may span multiple lines and may carry a
 * trailing `\n`. The value is split on `\n` and any trailing empty element
 * (produced by the trailing newline) is dropped so that it does not become a
 * spurious blank output line.
 *
 * Line prefix mapping per part type:
 *   - context (neither added nor removed): a single leading space then the line
 *   - removed (`part.removed === true`): `red('-' + line)`
 *   - added (`part.added === true`): `green('+' + line)`
 *
 * Coloring routes through `color.ts` `red`/`green` helpers, so `NO_COLOR` /
 * non-TTY environments degrade to literal `-` / `+` prefixed lines with no
 * ANSI escape sequences. Picocolors owns the detection logic.
 */
export function diffLinesToUnified(oldStr: string, newStr: string): string[] {
  const parts = diffLines(oldStr, newStr);
  const lines: string[] = [];
  for (const part of parts) {
    const partLines = part.value.split('\n');
    // A part value ending in '\n' yields a trailing '' after split; drop it.
    if (partLines.at(-1) === '') {
      partLines.pop();
    }
    let prefix: (line: string) => string;
    if (part.removed) prefix = (line) => red(`-${line}`);
    else if (part.added) prefix = (line) => green(`+${line}`);
    else prefix = (line) => ` ${line}`;
    for (const line of partLines) {
      lines.push(prefix(line));
    }
  }
  return lines;
}
