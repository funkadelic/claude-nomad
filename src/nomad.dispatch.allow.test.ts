import { describe, expect, it } from 'vitest';

import { parseAllowArgs } from './nomad.dispatch.allow.ts';

// parseAllowArgs is pure so no env sandbox is needed.

describe('parseAllowArgs', () => {
  it('returns a single-element array for one positional fingerprint', () => {
    const argv = ['node', 'nomad.ts', 'allow', 'path/to/file.jsonl:generic-api-key:42'];
    expect(parseAllowArgs(argv)).toEqual(['path/to/file.jsonl:generic-api-key:42']);
  });

  it('returns all positionals for multiple fingerprints', () => {
    const argv = ['node', 'nomad.ts', 'allow', 'a:b:1', 'c:d:2', 'e:f:3'];
    expect(parseAllowArgs(argv)).toEqual(['a:b:1', 'c:d:2', 'e:f:3']);
  });

  it('returns null when no positionals are given (argv length 3)', () => {
    const argv = ['node', 'nomad.ts', 'allow'];
    expect(parseAllowArgs(argv)).toBeNull();
  });

  it('returns null when any positional starts with a dash', () => {
    const argv = ['node', 'nomad.ts', 'allow', '--bogus'];
    expect(parseAllowArgs(argv)).toBeNull();
  });

  it('returns null when a later positional starts with a dash', () => {
    const argv = ['node', 'nomad.ts', 'allow', 'a:b:1', '--bogus'];
    expect(parseAllowArgs(argv)).toBeNull();
  });
});
