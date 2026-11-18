import { describe, expect, it } from 'vitest';

import { NomadFatal } from '../../core/utils.ts';
import { assertOverlaySafe } from './gitleaks.overlay-guard.ts';

const SCOPED =
  "[[allowlists]]\npaths = ['''^a\\.txt$''']\nregexes = ['''X''']\ncondition = \"AND\"\n";

describe('assertOverlaySafe', () => {
  it.each([
    ['a scoped AND block', SCOPED, false],
    ['a paths-only block', "[[allowlists]]\npaths = ['''^a\\.txt$''']\n", false],
    ['a lowercase "and" condition', SCOPED.replace('"AND"', '"and"'), false],
    ['upper-case keys', SCOPED.replace('paths', 'PATHS').replace('condition', 'Condition'), false],
    ['a legacy [allowlist] table', SCOPED.replace('[[allowlists]]', '[allowlist]'), true],
    ['no allowlists at all', '# nothing yet\n', false],
    ['a path with leading Go flags', "[[allowlists]]\npaths = ['''(?iU)^a\\.txt$''']\n", false],
  ])('accepts %s', (_label, body, legacy) => {
    expect(assertOverlaySafe(body)).toEqual({ legacy });
  });

  it.each([
    ['an escaped table name', "[[\"allow\\u006cists\"]]\nregexes = ['''X''']\n", /path-scoped/],
    [
      'a quoted matcher key',
      "[[allowlists]]\npaths = ['''^a''']\n\"regexes\" = ['''X''']\n",
      /condition = "AND"/,
    ],
    [
      'condition = "AND" inside a multiline string',
      "[[allowlists]]\npaths = ['''^a''']\nregexes = ['''\ncondition = \"AND\"\n''']\n",
      /condition = "AND"/,
    ],
    ['upper-case keys with no paths', "[[ALLOWLISTS]]\nREGEXES = ['''X''']\n", /path-scoped/],
    ['an empty paths list', '[[allowlists]]\npaths = []\n', /path-scoped/],
    ['a catch-all regex', SCOPED.replace("'''X'''", "'''.*'''"), /catch-all/],
    ['a catch-all path', "[[allowlists]]\npaths = ['''^.*$''']\n", /catch-all/],
    [
      'stopwords with OR',
      "[[allowlists]]\npaths = ['''^a''']\nstopwords = ['X']\ncondition = 'OR'\n",
      /AND/,
    ],
    ['a quoted extend table', '["extend"]\npath = "/evil"\n', /\[extend\] block/],
    ['an upper-case extend key', 'EXTEND = { path = "/evil" }\n', /\[extend\] block/],
    [
      'keys repeated in another case',
      "[[allowlists]]\npaths = ['''^a''']\nPaths = ['''^b''']\n",
      /letter cases/,
    ],
    ['top-level keys repeated in another case', 'title = "a"\nTitle = "b"\n', /letter cases/],
    ['a non-table allowlists value', 'allowlists = ["X"]\n', /must be tables/],
    ['invalid TOML', '[[allowlists]\n', /not valid TOML/],
    ['a quoted dotted allowlist key', "\"allowlist.regexes\" = ['''X''']\n", /contains a dot/],
    [
      'a quoted dotted key in a block',
      "[[allowlists]]\npaths = ['''^a''']\n\"x.y\" = 1\n",
      /contains a dot/,
    ],
    ['an empty path pattern', '[[allowlists]]\npaths = [""]\n', /catch-all/],
    ['a single-dot path pattern', "[[allowlists]]\npaths = ['''.''']\n", /catch-all/],
    ['a bare-anchor path pattern', "[[allowlists]]\npaths = ['''^''']\n", /catch-all/],
    ['a flagged catch-all path', "[[allowlists]]\npaths = ['''(?s).*''']\n", /catch-all/],
    ['a non-string path', '[[allowlists]]\npaths = [1]\n', /catch-all/],
    ['a path JS cannot compile', "[[allowlists]]\npaths = ['''(?P<n>a)''']\n", /catch-all/],
  ])('rejects %s', (_label, body, message) => {
    expect(() => assertOverlaySafe(body)).toThrow(NomadFatal);
    expect(() => assertOverlaySafe(body)).toThrow(message);
  });
});
