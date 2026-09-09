import { describe, expect, it } from 'vitest';

import { EXIT } from './exit-codes.ts';

describe('EXIT', () => {
  it('resolves SUCCESS to 0', () => {
    expect(EXIT.SUCCESS).toBe(0);
  });

  it('resolves GENERIC_FAILURE to 1', () => {
    expect(EXIT.GENERIC_FAILURE).toBe(1);
  });

  it('resolves USAGE to 2', () => {
    expect(EXIT.USAGE).toBe(2);
  });

  it('resolves CONFLICT to 4', () => {
    expect(EXIT.CONFLICT).toBe(4);
  });

  it('resolves LEAK_BLOCKED to 5', () => {
    expect(EXIT.LEAK_BLOCKED).toBe(5);
  });

  it('resolves INTERRUPTED to 130', () => {
    expect(EXIT.INTERRUPTED).toBe(130);
  });

  it('has no member equal to the reserved value 3', () => {
    expect(Object.values(EXIT)).not.toContain(3);
  });

  it('is a flat object of numeric values only', () => {
    expect(Object.values(EXIT).every((v) => typeof v === 'number')).toBe(true);
    expect(Object.keys(EXIT).sort()).toEqual(
      ['SUCCESS', 'GENERIC_FAILURE', 'USAGE', 'CONFLICT', 'LEAK_BLOCKED', 'INTERRUPTED'].sort(),
    );
  });
});
