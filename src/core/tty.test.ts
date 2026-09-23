import { describe, expect, it } from 'vitest';

import { isTTY } from './tty.ts';

describe('isTTY', () => {
  it('returns false when stdin.isTTY is undefined', () => {
    expect(isTTY({ isTTY: undefined }, { isTTY: true })).toBe(false);
  });

  it('returns false when stdout.isTTY is undefined', () => {
    expect(isTTY({ isTTY: true }, { isTTY: undefined })).toBe(false);
  });

  it('returns false when both are undefined', () => {
    expect(isTTY({ isTTY: undefined }, { isTTY: undefined })).toBe(false);
  });

  it('returns true when both stdin and stdout report isTTY === true', () => {
    expect(isTTY({ isTTY: true }, { isTTY: true })).toBe(true);
  });
});
