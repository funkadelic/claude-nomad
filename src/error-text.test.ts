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

  // Every caller runs inside a catch whose contract is to report and carry on,
  // so the composer itself must never throw. Conversion is the step that can:
  // a property read cannot fail, but `String` can, for these three shapes.
  it('stands in for a null-prototype object rather than throwing on conversion', () => {
    expect(errorText(Object.create(null))).toBe('unprintable error value');
  });

  it('stands in for a value whose toString throws', () => {
    const hostile = {
      toString() {
        throw new Error('conversion refused');
      },
    };
    expect(errorText(hostile)).toBe('unprintable error value');
  });

  it('stands in for a value whose message getter throws', () => {
    const hostile = {
      get message(): string {
        throw new Error('read refused');
      },
    };
    expect(errorText(hostile)).toBe('unprintable error value');
  });
});
