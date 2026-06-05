import { describe, expect, it } from 'vitest';

import { failGlyph, okGlyph, warnGlyph } from './color.ts';
import { addChildItem, addItem, section } from './commands.doctor.format.ts';
import { buildVerdictSection } from './commands.doctor.verdict.ts';

describe('buildVerdictSection', () => {
  it('returns a single healthy line when no section carries a WARN or FAIL glyph', () => {
    const a = section('A');
    addItem(a, `${okGlyph} fine`);
    const b = section('B');
    addItem(b, 'informational');
    const summary = buildVerdictSection([a, b]);
    expect(summary.header).toBe('Summary');
    expect(summary.items).toEqual([`${okGlyph} healthy`]);
  });

  it('repeats WARN lines and closes with the warning count when no failures exist', () => {
    const a = section('A');
    addItem(a, `${okGlyph} fine`);
    addItem(a, `${warnGlyph} drifting (run nomad update)`);
    const summary = buildVerdictSection([a]);
    expect(summary.items).toEqual([
      `${warnGlyph} drifting (run nomad update)`,
      `${warnGlyph} 1 warning(s)`,
    ]);
  });

  it('lists failures before warnings and closes with both counts', () => {
    const a = section('A');
    addItem(a, `${warnGlyph} soft problem`);
    const b = section('B');
    addItem(b, `${failGlyph} hard problem`);
    const summary = buildVerdictSection([a, b]);
    expect(summary.items).toEqual([
      `${failGlyph} hard problem`,
      `${warnGlyph} soft problem`,
      `${failGlyph} 1 failure(s), 1 warning(s)`,
    ]);
  });

  it('strips the child-item marker so repeated nested problems render flat', () => {
    const a = section('A');
    addItem(a, 'parent');
    addChildItem(a, `${warnGlyph} nested problem`);
    const summary = buildVerdictSection([a]);
    expect(summary.items[0]).toBe(`${warnGlyph} nested problem`);
    expect(summary.items[0].startsWith('\t')).toBe(false);
  });

  it('counts a line carrying both glyphs as a failure, not a warning', () => {
    const a = section('A');
    addItem(a, `${failGlyph} broke while warning ${warnGlyph}`);
    const summary = buildVerdictSection([a]);
    expect(summary.items[summary.items.length - 1]).toBe(`${failGlyph} 1 failure(s), 0 warning(s)`);
  });
});
