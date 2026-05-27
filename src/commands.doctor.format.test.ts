import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderDoctor, section, addItem } from './commands.doctor.format.ts';

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

describe('renderDoctor blank-line and elbow handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an empty-string item as a true blank line, not a tree connector', () => {
    const s = section('Header');
    addItem(s, 'first');
    addItem(s, '');
    addItem(s, 'second');
    const lines = captureLog(() => renderDoctor([s]));
    // The blank item is a bare empty line with no `├`/`└` prefix.
    expect(lines).toContain('');
    expect(lines.some((l) => l.trim() === '├' || l.trim() === '└')).toBe(false);
  });

  it('attaches the elbow to the last non-empty item, not a trailing blank', () => {
    const s = section('Header');
    addItem(s, 'first');
    addItem(s, 'last-content');
    addItem(s, '');
    const lines = captureLog(() => renderDoctor([s]));
    // The elbow lands on the last content row; the trailing blank stays bare.
    expect(lines.some((l) => l.includes('└ last-content'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('');
  });
});
