/**
 * Identity-fallback ANSI color helpers used exclusively by `cmdDoctor`.
 *
 * The seven exports wrap their picocolors equivalents when color is enabled
 * (per the picocolors `isColorSupported` flag) and return their input unchanged
 * when disabled. Picocolors already handles `NO_COLOR`, `FORCE_COLOR`,
 * `--no-color`, `--color`, `win32`, `TTY`, `TERM=dumb`, and `CI` natively, so
 * we delegate detection rather than rolling a hand-built TTY probe.
 *
 * Win32 caveat: picocolors forces color ON for `process.platform === 'win32'`
 * even on piped output. The supported user surface is WSL / Linux / macOS
 * where `process.platform` is `linux` or `darwin`; native Windows users can
 * opt out via `NO_COLOR=1`.
 *
 * The `enabled` flag is read once at module load and constant for the rest of
 * the CLI invocation; tests must `vi.resetModules()` between env-var toggles.
 */
import pc from 'picocolors';

const enabled = pc.isColorSupported;

/** Wraps the FAIL glyph (failGlyph) and gitlink path warnings. */
export const red = (s: string): string => (enabled ? pc.red(s) : s);

/** Wraps the WARN glyph (warnGlyph). */
export const yellow = (s: string): string => (enabled ? pc.yellow(s) : s);

/** Wraps the PASS glyph (okGlyph) and short positive tags. */
export const green = (s: string): string => (enabled ? pc.green(s) : s);

/** Hostnames and URLs. */
export const cyan = (s: string): string => (enabled ? pc.cyan(s) : s);

/** Absolute paths. */
export const blue = (s: string): string => (enabled ? pc.blue(s) : s);

/** Version strings and counts. */
export const dim = (s: string): string => (enabled ? pc.dim(s) : s);

/** Combined-bold variant (e.g., `red(bold(...))` for emphasized error headers). */
export const bold = (s: string): string => (enabled ? pc.bold(s) : s);

/**
 * WSL / Windows-Terminal width hack. On WSL the VS15-suffixed glyphs below
 * (`⚠︎`, `ℹ︎`) render at 2 terminal columns even though VS15 nominally forces
 * 1-column text presentation, while `✓`/`✗` (East-Asian-Width=Narrow) stay at
 * 1 column. The call-site format `${glyph} ${msg}` then puts `msg` one column
 * to the right after a warn/info glyph than after an ok/fail glyph, breaking
 * the gutter alignment (`ℹ︎ host:` shifts one cell right of `✓ repo:`). The
 * fix is to append an extra space to the NARROW `okGlyph`/`failGlyph` so all
 * four glyphs occupy a 2-column rendered footprint on WSL. Native Linux and
 * macOS terminals render every glyph at 1 column and need no compensation.
 *
 * Detection uses the `WSL_DISTRO_NAME` env var (always set by WSL2's init,
 * present in interactive shells and propagated to subprocesses). The check
 * runs at module load and is constant for the rest of the invocation.
 */
const wslNarrowPad = process.env.WSL_DISTRO_NAME ? ' ' : '';

/** PASS indicator glyph (U+2713 CHECK MARK). Wrap in `green()` at call sites. */
export const okGlyph = `✓${wslNarrowPad}`;

/** FAIL indicator glyph (U+2717 BALLOT X). Wrap in `red()` at call sites. */
export const failGlyph = `✗${wslNarrowPad}`;

/**
 * WARN indicator glyph (U+26A0 WARNING SIGN + U+FE0E VARIATION SELECTOR-15
 * for text-presentation; the VS15 forces monochrome rendering so the symbol
 * does not flash as a colored emoji on terminals with emoji-presentation
 * defaults). Wrap in `yellow()` at call sites.
 */
export const warnGlyph = '⚠︎';

/**
 * Informational marker (U+2139 INFORMATION SOURCE + U+FE0E VARIATION
 * SELECTOR-15 for text-presentation; the VS15 forces monochrome rendering
 * so the symbol does not flash as a colored emoji on terminals with
 * emoji-presentation defaults). Wrap in `dim()` at call sites so info rows
 * do not compete visually with PASS/FAIL/WARN status glyphs.
 */
export const infoGlyph = 'ℹ︎';
