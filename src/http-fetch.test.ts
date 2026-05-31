import { describe, expect, it } from 'vitest';

import { fetchUrl } from './http-fetch.ts';
import type { SpawnSyncFn } from './gh-actions.ts';

// Transport-only fetcher unit tests.
// All three branches are driven with injected SpawnSyncFn factories so no
// real subprocess is spawned.

const TEST_URL = 'https://example.com/data';

/**
 * Build a SpawnSyncFn that returns a fixed body for `bin` and throws ENOENT
 * for any other binary.
 *
 * @param bin - The binary to simulate as present.
 * @param body - The response body to return.
 */
function runPresent(bin: string, body: string): SpawnSyncFn {
  return (b, args) => {
    if (b === bin) {
      // Assert the url was passed verbatim as the last arg.
      expect(args[args.length - 1]).toBe(TEST_URL);
      return Buffer.from(body);
    }
    throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: 'ENOENT' });
  };
}

/**
 * Build a SpawnSyncFn that throws ENOENT for every binary (both curl and wget
 * absent).
 */
function runBothAbsent(): SpawnSyncFn {
  return (b) => {
    throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: 'ENOENT' });
  };
}

describe('fetchUrl', () => {
  it('returns the curl stdout body when curl succeeds', () => {
    const result = fetchUrl(TEST_URL, runPresent('curl', '{"version":"1.2.3"}'));
    expect(result).toBe('{"version":"1.2.3"}');
  });

  it('falls back to wget and returns its body when curl throws', () => {
    const wgetBody = '{"version":"1.2.3"}';
    // curl throws, wget succeeds.
    const run: SpawnSyncFn = (b, args) => {
      if (b === 'curl') {
        throw Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' });
      }
      if (b === 'wget') {
        expect(args[args.length - 1]).toBe(TEST_URL);
        return Buffer.from(wgetBody);
      }
      throw new Error(`unexpected binary: ${b}`);
    };
    const result = fetchUrl(TEST_URL, run);
    expect(result).toBe(wgetBody);
  });

  it('returns null when both curl and wget throw', () => {
    const result = fetchUrl(TEST_URL, runBothAbsent());
    expect(result).toBeNull();
  });

  it('passes the url verbatim to curl when curl is the active binary', () => {
    // The url-passthrough assertion is inside runPresent; no extra assertion needed.
    const result = fetchUrl(TEST_URL, runPresent('curl', 'body'));
    expect(result).toBe('body');
  });

  it('passes the url verbatim to wget when wget is the active binary', () => {
    // The url-passthrough assertion is inside runPresent; no extra assertion needed.
    const result = fetchUrl(TEST_URL, runPresent('wget', 'body'));
    expect(result).toBe('body');
  });
});
