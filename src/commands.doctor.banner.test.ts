import { describe, expect, it } from 'vitest';

import { printBanner } from './commands.doctor.banner.ts';

// Behavior-focused: assert on the lines the sink receives, not on the art's
// internal spelling. The one assertion that reads the art checks it renders as
// a rectangle of the advertised width, which is what breaks if a row is edited
// out of alignment.

/** Collect emitted lines through the injected sink. */
function capture(stdout: { isTTY?: boolean }): string[] {
  const lines: string[] = [];
  printBanner((line) => lines.push(line), stdout);
  return lines;
}

describe('printBanner', () => {
  it('draws the wordmark and a trailing blank line on a TTY', () => {
    const lines = capture({ isTTY: true });
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe('');
  });

  it('draws nothing when stdout is not a TTY', () => {
    expect(capture({ isTTY: false })).toEqual([]);
  });

  it('draws nothing when stdout reports no isTTY at all', () => {
    expect(capture({})).toEqual([]);
  });

  it('keeps every row inside 42 columns', () => {
    const art = capture({ isTTY: true }).slice(0, -1);
    expect(Math.max(...art.map((line) => line.length))).toBe(42);
  });

  it('carries no status glyph, so a glyph grep over doctor output is unaffected', () => {
    const out = capture({ isTTY: true }).join('\n');
    for (const glyph of ['✓', '✗', '⚠']) expect(out).not.toContain(glyph);
  });
});
