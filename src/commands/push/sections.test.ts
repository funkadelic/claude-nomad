import { describe, expect, it } from 'vitest';

import { buildSessionsSection, buildSettingsSection } from './sections.ts';

describe('buildSettingsSection', () => {
  it('renders the existing ok row unchanged when nothing is blocked', () => {
    const s = buildSettingsSection('no host overrides', []);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('✓');
    expect(s.items[0]).toContain('settings.json (base + no host overrides)');
  });

  it('renders a fail row naming the blocked key and the recovery command', () => {
    const s = buildSettingsSection('no host overrides', ['hooks']);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toContain('✗');
    expect(s.items[0]).toContain('hooks');
    expect(s.items[0]).toContain(
      "run 'nomad capture-settings', or delete from ~/.claude/settings.json",
    );
    expect(s.items[0]).not.toContain('base + no host overrides');
  });
});

/**
 * Unit tests for `buildSessionsSection`'s additive `localOnly` parameter.
 * The pull side passes the retained-but-unpushed local-only count so a
 * `⚠︎` WARN row surfaces after the "not in path-map" skip row; every push
 * caller keeps the default `localOnly = 0`, so push output stays byte-identical.
 * Color is disabled under vitest, so the WARN glyph renders as the bare `⚠︎`.
 */
describe('buildSessionsSection localOnly WARN row', () => {
  /** Join a section's rendered item rows into one newline-delimited string. */
  function itemsText(items: string[]): string {
    return items.join('\n');
  }

  it('emits no local-only WARN row when localOnly is 0 (push default)', () => {
    const s = buildSessionsSection([], 0, 0);
    expect(s.items).toEqual([]);
    expect(itemsText(s.items)).not.toContain('local-only present');
  });

  it('omitting localOnly (push callers) produces no local-only WARN row', () => {
    const s = buildSessionsSection(['foo'], 0);
    // Only the synced ✓ row; no WARN row.
    expect(itemsText(s.items)).not.toContain('local-only present');
    expect(s.items.some((row) => row.includes('foo'))).toBe(true);
  });

  it('emits a single ⚠︎ WARN row when localOnly > 0', () => {
    const s = buildSessionsSection([], 0, 3);
    const warnRows = s.items.filter((row) => row.includes('local-only present'));
    expect(warnRows).toHaveLength(1);
    expect(warnRows[0]).toContain('⚠︎');
    expect(warnRows[0]).toContain('3 local-only present, not in repo (push to reconcile)');
  });

  it('places the local-only WARN row AFTER the not-in-path-map skip row', () => {
    const s = buildSessionsSection(['foo'], 2, 5);
    const skipIdx = s.items.findIndex((row) => row.includes('not in path-map'));
    const warnIdx = s.items.findIndex((row) => row.includes('local-only present'));
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(skipIdx);
  });
});
