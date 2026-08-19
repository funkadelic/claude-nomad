import { describe, expect, it } from 'vitest';

import { errorText } from './error-text.ts';

describe('errorText', () => {
  it('returns the message verbatim for a real Error carrying one', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('returns the string itself for a thrown string, since a string has no message', () => {
    expect(errorText('bare string thrown')).toBe('bare string thrown');
  });

  it('returns the String form for a thrown plain object with no message property', () => {
    expect(errorText({ code: 'ENOENT' })).toBe('[object Object]');
  });

  it('returns the String form for a thrown null without throwing', () => {
    expect(errorText(null)).toBe('null');
  });

  it('returns the String form for a thrown undefined without throwing', () => {
    expect(errorText(undefined)).toBe('undefined');
  });

  it('returns the message for a cross-realm-shaped object carrying a string message but not an Error instance', () => {
    const crossRealm = { name: 'Error', message: 'cross-realm failure' };
    expect(crossRealm).not.toBeInstanceOf(Error);
    expect(errorText(crossRealm)).toBe('cross-realm failure');
  });
});
