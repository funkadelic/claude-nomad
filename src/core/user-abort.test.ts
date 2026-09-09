import { describe, expect, it } from 'vitest';

import { isUserAbort } from './user-abort.ts';

describe('isUserAbort', () => {
  it('returns false for a non-object primitive input', () => {
    expect(isUserAbort('boom')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUserAbort(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUserAbort(undefined)).toBe(false);
  });

  it('returns true for an Error whose name is the readline abort name', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isUserAbort(err)).toBe(true);
  });

  it('returns true for a bare object carrying only the readline abort code', () => {
    expect(isUserAbort({ code: 'ABORT_ERR' })).toBe(true);
  });

  it('returns true for a bare object carrying only the inquirer-family prompt-exit name', () => {
    expect(isUserAbort({ name: 'ExitPromptError' })).toBe(true);
  });

  it('returns false for a plain Error', () => {
    expect(isUserAbort(new Error('boom'))).toBe(false);
  });

  it('returns false when name is a non-string', () => {
    expect(isUserAbort({ name: 42 })).toBe(false);
  });

  it('returns true for the real observed Ctrl+C readline abort shape', () => {
    const err = new Error('Aborted with Ctrl+C');
    err.name = 'AbortError';
    expect(isUserAbort(err)).toBe(true);
  });
});
