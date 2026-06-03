import { afterEach, describe, expect, it, vi } from 'vitest';

import { addItem, renderDoctor, renderTree, section } from './output-tree.ts';

/**
 * Capture every `console.log` line emitted while `fn` runs, returning them as
 * an array. Mirrors the console-spy pattern used by the preview tests; the
 * spy is restored in `afterEach`.
 */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  fn();
  return lines;
}

describe('renderTree blank-line and elbow handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an empty-string item as a true blank line, not a tree connector', () => {
    const s = section('Header');
    addItem(s, 'first');
    addItem(s, '');
    addItem(s, 'second');
    const lines = captureLog(() => renderTree([s]));
    // The blank item is a bare empty line with no `├`/`└` prefix.
    expect(lines).toContain('');
    expect(lines.some((l) => l.trim() === '├' || l.trim() === '└')).toBe(false);
  });

  it('attaches the elbow to the last non-empty item, not a trailing blank', () => {
    const s = section('Header');
    addItem(s, 'first');
    addItem(s, 'last-content');
    addItem(s, '');
    const lines = captureLog(() => renderTree([s]));
    // The elbow lands on the last content row; the trailing blank stays bare.
    expect(lines.some((l) => l.includes('└ last-content'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('');
  });

  it('skips empty sections and writes one blank line between rendered sections', () => {
    const first = section('First');
    addItem(first, 'a');
    const empty = section('Empty');
    const second = section('Second');
    addItem(second, 'b');
    const lines = captureLog(() => renderTree([first, empty, second]));
    // Empty section header never appears; the two visible sections are
    // separated by exactly one blank line with no leading or trailing blank.
    expect(lines.some((l) => l.includes('Empty'))).toBe(false);
    expect(lines).toEqual(['First', '  └ a', '', 'Second', '  └ b']);
  });
});

describe('raw section rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders raw items as two-space-indented lines with no tree connectors', () => {
    const s = section('settings.json', true);
    addItem(s, '--- a');
    addItem(s, '+++ b');
    // A space-prefixed diff context line: the two-space indent prepends, so
    // the rendered line is `  ` + ` unchanged` = `   unchanged` (three spaces).
    addItem(s, ' unchanged');
    const lines = captureLog(() => renderTree([s]));
    expect(lines).toEqual(['settings.json', '  --- a', '  +++ b', '   unchanged']);
    // No ├ or └ connectors.
    expect(lines.some((l) => l.includes('├') || l.includes('└'))).toBe(false);
  });

  it('raw header prints verbatim even when an item contains the fail glyph', () => {
    const s = section('settings.json', true);
    addItem(s, '✗ something bad');
    const lines = captureLog(() => renderTree([s]));
    // Header must NOT get the `✗ ` prefix.
    expect(lines[0]).toBe('settings.json');
  });

  it('raw empty-string items render as true blank lines', () => {
    const s = section('Diff', true);
    addItem(s, 'line1');
    addItem(s, '');
    addItem(s, 'line2');
    const lines = captureLog(() => renderTree([s]));
    expect(lines).toEqual(['Diff', '  line1', '', '  line2']);
  });

  it('empty raw section is still skipped by renderTree', () => {
    const raw = section('Raw', true);
    const normal = section('Normal');
    addItem(normal, 'item');
    const lines = captureLog(() => renderTree([raw, normal]));
    expect(lines.some((l) => l.includes('Raw'))).toBe(false);
    expect(lines).toEqual(['Normal', '  └ item']);
  });

  it('non-raw section (default) rendering stays byte-identical', () => {
    const s = section('Header');
    addItem(s, 'first');
    addItem(s, 'second');
    const lines = captureLog(() => renderTree([s]));
    expect(lines).toEqual(['Header', '  ├ first', '  └ second']);
  });

  it('section(header) and section(header, false) produce identical non-raw output', () => {
    const s1 = section('H');
    addItem(s1, 'x');
    const s2 = section('H', false);
    addItem(s2, 'x');
    const lines1 = captureLog(() => renderTree([s1]));
    const lines2 = captureLog(() => renderTree([s2]));
    expect(lines1).toEqual(lines2);
  });
});

describe('renderDoctor alias', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is the same implementation as renderTree (doctor call site stays valid)', () => {
    expect(renderDoctor).toBe(renderTree);
    const s = section('Header');
    addItem(s, 'only');
    const lines = captureLog(() => renderDoctor([s]));
    expect(lines).toEqual(['Header', '  └ only']);
  });
});
