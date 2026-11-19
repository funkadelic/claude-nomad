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
    ['a Go named group', "[[allowlists]]\npaths = ['''^(?P<d>shared)/a\\.txt$''']\n", false],
    [
      'a key named like an Object method',
      "[[allowlists]]\npaths = ['''^a''']\nconstructor = 1\n",
      false,
    ],
    ['a rule with a new id', "[[rules]]\nid = 'my-token'\nregex = '''abc'''\n", false],
    [
      'a new-id rule with an unscoped rule allowlist',
      "[[rules]]\nid = 'my-token'\nregex = '''abc'''\n[[rules.allowlists]]\nregexes = ['''.*''']\n",
      false,
    ],
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
    ['a path JS cannot compile', "[[allowlists]]\npaths = ['''^[[:alpha:]]''']\n", /catch-all/],
    ['a Go-only \\A path', "[[allowlists]]\npaths = ['''\\A''']\n", /catch-all/],
    ['a Go-only \\Q\\E path', "[[allowlists]]\npaths = ['''\\Q\\E''']\n", /catch-all/],
    ['a Go-only \\pL path', "[[allowlists]]\npaths = ['''\\pL*''']\n", /catch-all/],
    ['an extension-wide path', "[[allowlists]]\npaths = ['''\\.md$''']\n", /catch-all/],
    ['a flagged catch-all regex', SCOPED.replace("'''X'''", "'''(?i).*'''"), /catch-all/],
    ['a lazy catch-all regex', SCOPED.replace("'''X'''", "'''.*?'''"), /catch-all/],
    ['a class catch-all regex', SCOPED.replace("'''X'''", "'''[\\s\\S]*'''"), /catch-all/],
    ['an empty-matching regex', SCOPED.replace("'''X'''", "'''X?'''"), /catch-all/],
    [
      'a rule reusing a built-in id',
      "[[rules]]\nid = 'github-pat'\nregex = '''(?!)'''\n",
      /built-in gitleaks rule id/,
    ],
    [
      'a built-in id with an unscoped rule allowlist',
      "[[rules]]\nid = 'github-pat'\nregex = '''abc'''\n[[rules.allowlists]]\nregexes = ['''.*''']\n",
      /built-in gitleaks rule id/,
    ],
    ['an upper-case id key', "[[rules]]\nID = 'github-pat'\n", /built-in gitleaks rule id/],
    ['an upper-case rules table', "[[Rules]]\nid = 'github-pat'\n", /built-in gitleaks rule id/],
    [
      'a built-in id in another case',
      "[[rules]]\nid = 'GitHub-PAT'\n",
      /built-in gitleaks rule id/,
    ],
    ['a rule with no id', "[[rules]]\nregex = '''abc'''\n", /needs an `id`/],
    ['a non-string rule id', '[[rules]]\nid = 1\n', /needs an `id`/],
    ['an empty rule id', "[[rules]]\nid = ''\n", /needs an `id`/],
    ['a string rules value', "rules = 'x'\n", /\[\[rules\]\] blocks/],
    ['a single [rules] table', "[rules]\nid = 'my-token'\n", /\[\[rules\]\] blocks/],
    ['a non-table rules entry', "rules = ['x']\n", /\[\[rules\]\] blocks/],
  ])('rejects %s', (_label, body, message) => {
    expect(() => assertOverlaySafe(body)).toThrow(NomadFatal);
    expect(() => assertOverlaySafe(body)).toThrow(message);
  });

  it('reports a TOML syntax error without echoing the overlay line', () => {
    const body = 'token = "ghp_zzEchoCanary"\nbad = =\n';
    expect(() => assertOverlaySafe(body)).toThrow(/not valid TOML .*line 2 column \d+/);
    expect(() => assertOverlaySafe(body)).not.toThrow(/zzEchoCanary/);
  });
});
