import { describe, expect, it } from 'vitest';

import { isSafeRelPath } from './rel-path-guard.ts';

/**
 * Tests for the shared per-segment traversal guard. Behavior-focused: only the
 * boolean verdict is asserted for each shape.
 */
describe('isSafeRelPath', () => {
  it('accepts a flat single-segment path', () => {
    expect(isSafeRelPath('notes.md')).toBe(true);
  });

  it('accepts a nested multi-segment path', () => {
    expect(isSafeRelPath('references/notes.md')).toBe(true);
  });

  it('rejects an empty path', () => {
    expect(isSafeRelPath('')).toBe(false);
  });

  it('rejects a leading slash', () => {
    expect(isSafeRelPath('/notes.md')).toBe(false);
  });

  it('rejects a backslash anywhere', () => {
    expect(isSafeRelPath('references\\notes.md')).toBe(false);
  });

  it('rejects a ".." segment', () => {
    expect(isSafeRelPath('../escape.md')).toBe(false);
  });

  it('rejects a "." segment', () => {
    expect(isSafeRelPath('./notes.md')).toBe(false);
  });

  it('rejects an empty segment (double slash)', () => {
    expect(isSafeRelPath('references//notes.md')).toBe(false);
  });
});
