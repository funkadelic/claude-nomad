import { describe, expect, it } from 'vitest';

import { compactSections } from './compact.ts';
import { MODALITY_COPY_SYNC, MODALITY_SYMLINK } from './checks/longpaths.ts';
import { failGlyph, okGlyph, warnGlyph, infoGlyph } from '../../color.ts';
import { type DoctorSection } from '../../output-tree.ts';

// Behavior-focused: assert on which items survive the compact transform for each
// section class. Items carry their status glyph in the text, exactly as the
// reporters emit them, so the filter is exercised through real glyph substrings.

const ok = (text: string): string => `${okGlyph} ${text}`;
const info = (text: string): string => `${infoGlyph} ${text}`;
const warn = (text: string): string => `${warnGlyph} ${text}`;
const fail = (text: string): string => `${failGlyph} ${text}`;
/** A nested child row, marked exactly as `addChildItem` marks one: leading tab, no glyph. */
const child = (text: string): string => `\t${text}`;

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

  it('keeps the child rows of a retained WARN row', () => {
    const [out] = compactSections([
      sec('Skills', [
        ok('agents: in sync'),
        warn('skills: 2 file(s) diverge'),
        child('a/SKILL.md'),
        child('b/SKILL.md'),
      ]),
    ]);
    expect(out.items).toEqual([
      warn('skills: 2 file(s) diverge'),
      child('a/SKILL.md'),
      child('b/SKILL.md'),
    ]);
  });

  it('drops the child rows of a dropped OK row', () => {
    const [out] = compactSections([
      sec('Path map', [
        ok('Mapped projects: 1'),
        child('nomad -> /home/n/nomad'),
        fail('collision'),
      ]),
    ]);
    expect(out.items).toEqual([fail('collision')]);
  });

  it('keeps child rows of a retained Environment row', () => {
    const [out] = compactSections([
      sec('Environment', [
        info('NOMAD_HOST: host'),
        child('ignored'),
        warn('drift'),
        child('CLAUDE.md'),
      ]),
    ]);
    expect(out.items).toEqual([warn('drift'), child('CLAUDE.md')]);
  });

  it('does not mutate the input sections', () => {
    const input = [sec('Repository', [ok('a'), warn('b')])];
    const snapshot = input[0].items.slice();
    compactSections(input);
    expect(input[0].items).toEqual(snapshot);
  });
});

// The sync-modality row is informational, so it would normally be filtered out
// of the compact view. The copy-sync variant is kept, because that is the one
// modality where the host-side file and the repo-side file are distinct.
//
// These assert against the literals `reportSyncModality` actually emits, so a
// reporter reword fails here instead of silently leaving a paraphrase behind.
// No platform stub is needed: the keep-rule is a pure function of the row text.
describe('compactSections sync-modality row', () => {
  const copySync = info(`sync modality: ${MODALITY_COPY_SYNC}`);
  const symlink = info(`sync modality: ${MODALITY_SYMLINK}`);

  it('keeps the copy-sync modality row in Environment', () => {
    const [out] = compactSections([sec('Environment', [ok('repo state: clean'), copySync])]);
    expect(out.items).toEqual([ok('repo state: clean'), copySync]);
  });

  it('drops the symlink modality row in Environment', () => {
    const [out] = compactSections([sec('Environment', [ok('repo state: clean'), symlink])]);
    expect(out.items).toEqual([ok('repo state: clean')]);
  });

  it('still drops other informational Environment rows alongside the kept one', () => {
    const [out] = compactSections([sec('Environment', [copySync, info('NOMAD_REPO: /tmp/x')])]);
    expect(out.items).toEqual([copySync]);
  });
});
