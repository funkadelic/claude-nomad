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

  it('leads with the warning count and nests each WARN line beneath it', () => {
    const a = section('A');
    addItem(a, `${okGlyph} fine`);
    addItem(a, `${warnGlyph} drifting (run nomad update)`);
    const summary = buildVerdictSection([a]);
    expect(summary.items).toEqual([`1 warning(s)`, `\t${warnGlyph} drifting (run nomad update)`]);
  });

  it('leads with both counts and nests failures before warnings', () => {
    const a = section('A');
    addItem(a, `${warnGlyph} soft problem`);
    const b = section('B');
    addItem(b, `${failGlyph} hard problem`);
    const summary = buildVerdictSection([a, b]);
    expect(summary.items).toEqual([
      `1 failure(s), 1 warning(s)`,
      `\t${failGlyph} hard problem`,
      `\t${warnGlyph} soft problem`,
    ]);
  });

  it('nests each finding exactly one level under the verdict, even when nested in its source', () => {
    const a = section('A');
    addItem(a, 'parent');
    addChildItem(a, `${warnGlyph} nested problem`);
    const summary = buildVerdictSection([a]);
    expect(summary.items[0]).toBe(`1 warning(s)`);
    expect(summary.items[1]).toBe(`\t${warnGlyph} nested problem`);
  });

  it('counts a line carrying both glyphs as a failure, not a warning', () => {
    const a = section('A');
    addItem(a, `${failGlyph} broke while warning ${warnGlyph}`);
    const summary = buildVerdictSection([a]);
    expect(summary.items[0]).toBe(`1 failure(s), 0 warning(s)`);
  });
});
