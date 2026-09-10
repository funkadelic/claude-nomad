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
    expect(opensSubstitution('`command')).toBe(true);
    expect(opensSubstitution('"`command')).toBe(true);
  });

  it('does not match a single-quoted literal', () => {
    // Single quotes suppress every expansion, so these are literal words.
    expect(opensSubstitution("'$(x)'")).toBe(false);
    expect(opensSubstitution("'`x`'")).toBe(false);
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
  it('skips a single-token $(...) substitution, leaving no word behind', () => {
    expect(skipSubstitution(tokens('$(x) after'), 0)).toEqual({ next: 1, rest: '' });
  });

  it('skips a $(...) substitution spanning several tokens', () => {
    expect(skipSubstitution(tokens('"$(command -v node)" after'), 0)).toEqual({
      next: 3,
      rest: '"',
    });
  });

  it('returns the text trailing the closing paren as the leftover word', () => {
    // The `$(dirname "$0")/hook.js` idiom: the script path rides in the same
    // token as the substitution that closes just before it.
    expect(skipSubstitution(tokens('$(pwd)/gsd-x.js after'), 0)).toEqual({
      next: 1,
      rest: '/gsd-x.js',
    });
  });

  it('reports the opening token as the leftover word for an unterminated $(...)', () => {
    // Not `tokens.length`: surrendering the remaining tokens would discard the
    // script path, which for a real gsd entry means deleting it on the next pull.
    expect(skipSubstitution(tokens('"$(for n in /usr/bin/node'), 0)).toEqual({
      next: 1,
      rest: '"$(for',
    });
  });

  it('skips a single-token backtick substitution', () => {
    expect(skipSubstitution(tokens('`node` after'), 0)).toEqual({ next: 1, rest: '' });
  });

  it('skips a backtick substitution spanning several tokens', () => {
    expect(skipSubstitution(tokens('`command -v node` after'), 0)).toEqual({ next: 3, rest: '' });
  });

  it('returns the text trailing the closing backtick as the leftover word', () => {
    expect(skipSubstitution(tokens('`pwd`/gsd-x.js after'), 0)).toEqual({
      next: 1,
      rest: '/gsd-x.js',
    });
  });

  it('honors a backslash-escaped backtick inside the body', () => {
    expect(skipSubstitution(tokens('`echo \\`x` after'), 0)).toEqual({ next: 2, rest: '' });
  });

  it('reports the opening token as the leftover word for an unterminated backtick', () => {
    expect(skipSubstitution(tokens('`command -v node'), 0)).toEqual({ next: 1, rest: '`command' });
  });

  it('does not let a quoted literal paren change the nesting depth', () => {
    // `(` inside quotes is body text, not syntax, so the `)` that follows is
    // still the one that closes the substitution.
    expect(skipSubstitution(tokens('$(printf "(") after'), 0)).toEqual({ next: 2, rest: '' });
    expect(skipSubstitution(tokens("$(echo '(') after"), 0)).toEqual({ next: 2, rest: '' });
    // Same body, with a script path trailing the close: the depth accounting and
    // the leftover-word offset have to agree, which the boolean cannot show.
    expect(skipSubstitution(tokens('$(printf "(")/gsd-x.js after'), 0)).toEqual({
      next: 2,
      rest: '/gsd-x.js',
    });
  });

  it('closes a nested $(...) opened inside a double-quoted run', () => {
    // The shape gsd's node-resolver uses: `"$(command -v node)"` nested inside a
    // wider substitution. The inner `)` must close only the inner one.
    expect(skipSubstitution(tokens('"$(a "$(b)" c)" after'), 0)).toEqual({ next: 3, rest: '"' });
    // The nested `$(` has to re-enter a COMMAND context, not stay inside the
    // double-quoted run: only then does the `'` open a literal where the `"` is
    // body text. Treated as still-quoted, that `"` ends the run and the scan
    // never finds its closing paren.
    expect(skipSubstitution(tokens('"$(a "$(echo \'"\')" b)" after'), 0)).toEqual({
      next: 4,
      rest: '"',
    });
  });

  it('honors a backslash-escaped paren inside the body', () => {
    // An escaped `(` does not open a level.
    expect(skipSubstitution(tokens('$(echo \\() after'), 0)).toEqual({ next: 2, rest: '' });
    // An escaped `)` does not close one, so the later bare `)` is the closer.
    expect(skipSubstitution(tokens('$(echo \\) x) after'), 0)).toEqual({ next: 3, rest: '' });
  });

  it('treats a nested backtick region as its own command', () => {
    // A `)` inside backticks belongs to that nested command, so it must not close
    // the outer `$(`. Closing early would resume the walk inside the body.
    expect(skipSubstitution(tokens('$(echo `a) b` ) after'), 0)).toEqual({ next: 4, rest: '' });
  });

  it('picks the opener that comes first in the token', () => {
    // `$(` first: scanned as a paren substitution, so a literal backtick in the
    // body closes nothing and the `)` ends it.
    expect(skipSubstitution(tokens('$(echo `x`) after'), 0)).toEqual({ next: 2, rest: '' });
    // Backtick first: scanned as a backtick substitution, so the `$(` in the
    // body opens nothing and the second backtick ends it.
    expect(skipSubstitution(tokens('`echo $(x`) after'), 0)).toEqual({ next: 2, rest: ')' });
    // Both openers inside one token, `$(` first: the backticks are body text.
    expect(skipSubstitution(tokens('$(a`b`) after'), 0)).toEqual({ next: 1, rest: '' });
  });

  it('consumes only the token itself when neither opener is present', () => {
    // Guards the documented precondition: without this the token would be
    // scanned as a substitution body and swallow the rest of the command.
    expect(skipSubstitution(tokens('node /a/gsd-x.js'), 0)).toEqual({ next: 1, rest: 'node' });
    expect(skipSubstitution([], 0)).toEqual({ next: 1, rest: '' });
  });
});
