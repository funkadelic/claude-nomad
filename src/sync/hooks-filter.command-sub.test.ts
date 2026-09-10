import { describe, expect, it } from 'vitest';

import { opensSubstitution, skipSubstitution } from './hooks-filter.command-sub.ts';

/** Split a command the way `isGsdHookEntry` does, so the scanner sees real tokens. */
function tokens(command: string): string[] {
  return command.trim().split(/\s+/);
}

describe('opensSubstitution', () => {
  it('matches both substitution forms, quoted or bare', () => {
    expect(opensSubstitution('$(command')).toBe(true);
    expect(opensSubstitution('"$(for')).toBe(true);
    expect(opensSubstitution("'$(x)'")).toBe(true);
    expect(opensSubstitution('`command')).toBe(true);
    expect(opensSubstitution('"`command')).toBe(true);
  });

  it('does not match a plain token', () => {
    expect(opensSubstitution('node')).toBe(false);
    expect(opensSubstitution('/a/hooks/gsd-x.js')).toBe(false);
    expect(opensSubstitution('')).toBe(false);
    // A substitution that opens mid-token is not in opener position.
    expect(opensSubstitution('-c$(x)')).toBe(false);
  });
});

describe('skipSubstitution', () => {
  it('skips a single-token $(...) substitution', () => {
    expect(skipSubstitution(tokens('$(x) after'), 0)).toBe(1);
  });

  it('skips a $(...) substitution spanning several tokens', () => {
    expect(skipSubstitution(tokens('"$(command -v node)" after'), 0)).toBe(3);
  });

  it('returns tokens.length for an unterminated $(...)', () => {
    const t = tokens('"$(for n in /usr/bin/node');
    expect(skipSubstitution(t, 0)).toBe(t.length);
  });

  it('skips a single-token backtick substitution', () => {
    expect(skipSubstitution(tokens('`node` after'), 0)).toBe(1);
  });

  it('skips a backtick substitution spanning several tokens', () => {
    expect(skipSubstitution(tokens('`command -v node` after'), 0)).toBe(3);
  });

  it('honors a backslash-escaped backtick inside the body', () => {
    expect(skipSubstitution(tokens('`echo \\`x` after'), 0)).toBe(2);
  });

  it('returns tokens.length for an unterminated backtick', () => {
    const t = tokens('`command -v node');
    expect(skipSubstitution(t, 0)).toBe(t.length);
  });

  it('picks the opener that comes first in the token', () => {
    // `$(` first: scanned as a paren substitution, so a literal backtick in the
    // body closes nothing and the `)` ends it. Next token is `after`, index 2.
    expect(skipSubstitution(tokens('$(echo `x`) after'), 0)).toBe(2);
    // Backtick first: scanned as a backtick substitution, so the `$(` in the
    // body opens nothing and the second backtick ends it. `after` is index 2.
    expect(skipSubstitution(tokens('`echo $(x`) after'), 0)).toBe(2);
    // Both openers inside one token, `$(` first: the backticks are body text.
    expect(skipSubstitution(tokens('$(a`b`) after'), 0)).toBe(1);
  });
});
