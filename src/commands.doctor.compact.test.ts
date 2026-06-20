import { describe, expect, it } from 'vitest';

import { compactSections } from './commands.doctor.compact.ts';
import { failGlyph, okGlyph, warnGlyph, infoGlyph } from './color.ts';
import { type DoctorSection } from './output-tree.ts';

// Behavior-focused: assert on which items survive the compact transform for each
// section class. Items carry their status glyph in the text, exactly as the
// reporters emit them, so the filter is exercised through real glyph substrings.

const ok = (text: string): string => `${okGlyph} ${text}`;
const info = (text: string): string => `${infoGlyph} ${text}`;
const warn = (text: string): string => `${warnGlyph} ${text}`;
const fail = (text: string): string => `${failGlyph} ${text}`;

function sec(header: string, items: string[]): DoctorSection {
  return { header, items };
}

describe('compactSections', () => {
  it('passes Nomad Version through unchanged, including its OK row', () => {
    const input = [sec('Nomad Version', [ok('claude-nomad: 1.0.0 (latest)')])];
    expect(compactSections(input)).toEqual(input);
  });

  it('passes the Summary verdict through unchanged', () => {
    const input = [sec('Summary', ['✓ healthy'])];
    expect(compactSections(input)).toEqual(input);
  });

  it('keeps the Shared scan and Schema scan sections in full on a clean pass', () => {
    const input = [
      sec('Shared scan', [ok('0 sessions staged'), info('legend')]),
      sec('Schema scan', [ok('all keys known')]),
    ];
    expect(compactSections(input)).toEqual(input);
  });

  it('keeps only the repo-state line and problems in Environment', () => {
    const [out] = compactSections([
      sec('Environment', [
        info('NOMAD_HOST: host'),
        ok('repo: /path'),
        ok('repo state: populated'),
        warn('something off'),
      ]),
    ]);
    expect(out.items).toEqual([ok('repo state: populated'), warn('something off')]);
  });

  it('drops a section whose rows are all OK/info (renderTree then skips it)', () => {
    const [out] = compactSections([sec('Path map', [ok('mapped'), info('note')])]);
    expect(out.items).toEqual([]);
  });

  it('keeps only WARN/FAIL rows in a non-special section', () => {
    const [out] = compactSections([
      sec('Repository', [ok('remote configured'), fail('gitlink found'), ok('rebase clean')]),
    ]);
    expect(out.items).toEqual([fail('gitlink found')]);
  });

  it('does not mutate the input sections', () => {
    const input = [sec('Repository', [ok('a'), warn('b')])];
    const snapshot = input[0].items.slice();
    compactSections(input);
    expect(input[0].items).toEqual(snapshot);
  });
});
