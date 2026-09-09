import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct unit coverage for diffLinesToUnified (the pure jsdiff-to-unified
 * line mapper). preview.test.ts only ever feeds JSON.stringify output, which
 * never contains an interior blank line and never carries a trailing newline,
 * so the trailing-empty drop guard and the lone-newline part path are
 * exercised but their output correctness is unverified there. These cases pin
 * the blank-line and trailing-newline behavior on hand-constructed strings.
 *
 * Color routes through color.ts, whose `enabled` flag is read once at module
 * load from picocolors. NO_COLOR=1 plus vi.resetModules() forces the literal
 * `-` / `+` / ` ` prefixes (no ANSI) regardless of the host TTY, mirroring the
 * env handling in preview.test.ts.
 */
describe('diffLinesToUnified', () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it('preserves an interior blank line as a context row', async () => {
    const { diffLinesToUnified } = await import('./diff-lines.ts');
    expect(diffLinesToUnified('a\n\nb\n', 'a\n\nc\n')).toEqual([' a', ' ', '-b', '+c']);
  });

  it('renders a lone-newline added part as a bare + row', async () => {
    const { diffLinesToUnified } = await import('./diff-lines.ts');
    expect(diffLinesToUnified('a\nb\n', 'a\n\nb\n')).toEqual([' a', '+', ' b']);
  });

  it('does not emit a spurious trailing blank for a trailing-newline input', async () => {
    const { diffLinesToUnified } = await import('./diff-lines.ts');
    expect(diffLinesToUnified('a\nb\n', 'a\nc\n')).toEqual([' a', '-b', '+c']);
  });

  it('returns only context rows for byte-identical input (no diff branch taken)', async () => {
    const { diffLinesToUnified } = await import('./diff-lines.ts');
    expect(diffLinesToUnified('a\nb\n', 'a\nb\n')).toEqual([' a', ' b']);
  });

  it('emits a bare - row for a removed-only line', async () => {
    const { diffLinesToUnified } = await import('./diff-lines.ts');
    expect(diffLinesToUnified('a\nb\n', 'a\n')).toEqual([' a', '-b']);
  });
});
