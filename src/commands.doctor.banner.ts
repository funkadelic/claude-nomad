/**
 * The `nomad` wordmark printed above a `nomad doctor` report.
 *
 * Drawn in the slanted figlet style: the letterforms lean right, which is the
 * italic look drawn into the characters themselves rather than applied with the
 * ANSI italic attribute. Doing it that way means the banner renders identically
 * everywhere, including terminals that ignore or repurpose the italic escape
 * (Windows conhost being the one nomad actually ships to), and it needs no
 * color, so `NO_COLOR` has nothing to strip.
 *
 * Widest line is 42 columns, inside an 80-column terminal with room to spare.
 * Backslashes are escaped, so read the rendered output, not the source, when
 * judging the art.
 */
const NOMAD_BANNER: readonly string[] = [
  '                                        __',
  '   ____   ____   ____ ___   ____ _ ____/ /',
  '  / __ \\ / __ \\ / __ `__ \\ / __ `// __  /',
  ' / / / // /_/ // / / / / // /_/ // /_/ /',
  '/_/ /_/ \\____//_/ /_/ /_/ \\__,_/ \\__,_/',
];

/**
 * Emit the wordmark followed by one blank line, ahead of every other line of
 * doctor output.
 *
 * Decoration only: it carries no status glyph, so it cannot disturb a
 * downstream `grep -F` for the PASS/FAIL/WARN glyphs, and it never touches
 * `process.exitCode`. Skipped entirely when stdout is not a TTY, so a piped or
 * redirected run and any CI capture keep the report alone, the same way
 * `spinner.ts` degrades off-TTY.
 *
 * Both collaborators are parameters rather than ambient reads so the two
 * branches are testable without stubbing `process.stdout`.
 *
 * @param log - line sink, `console.log` at the call site.
 * @param stdout - stream whose `isTTY` decides whether to draw at all.
 */
export function printBanner(log: (line: string) => void, stdout: { isTTY?: boolean }): void {
  if (stdout.isTTY !== true) return;
  for (const line of NOMAD_BANNER) log(line);
  log('');
}
