import { describe, it, expect } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { DEFAULT_HELP } from './nomad.help.ts';

describe('DEFAULT_HELP version header', () => {
  it('starts with the claude-nomad version prefix', () => {
    expect(DEFAULT_HELP.startsWith('claude-nomad v')).toBe(true);
  });

  it('contains the exact version from package.json', () => {
    expect(DEFAULT_HELP).toContain(`claude-nomad v${pkg.version}`);
  });

  it('still includes --version row (prepend did not displace content)', () => {
    expect(DEFAULT_HELP).toContain('--version');
  });

  it('still includes doctor subcommand (prepend did not displace content)', () => {
    expect(DEFAULT_HELP).toContain('doctor');
  });

  it('contains --force-remote row under pull', () => {
    expect(DEFAULT_HELP).toContain('--force-remote');
  });

  it('--force-remote row describes wedge recovery', () => {
    expect(DEFAULT_HELP).toMatch(/--force-remote.*[Rr]ecover/);
  });

  it('--force-remote row mentions nomad/stranded-<ts>', () => {
    expect(DEFAULT_HELP).toContain('nomad/stranded-');
  });
});

describe('DEFAULT_HELP eject row', () => {
  it('contains an eject subcommand entry', () => {
    expect(DEFAULT_HELP).toMatch(/\beject\b/);
  });

  it('eject row describes symlink materialization', () => {
    expect(DEFAULT_HELP).toMatch(/eject.*[Mm]aterialize/);
  });

  it('eject --dry-run flag is listed in the eject section', () => {
    // The --dry-run flag appears for multiple commands; slice out the eject
    // section (its row through the next blank line) and assert against that.
    const start = DEFAULT_HELP.indexOf('\n  eject');
    expect(start).toBeGreaterThan(-1);
    const end = DEFAULT_HELP.indexOf('\n\n', start + 1);
    expect(end).toBeGreaterThan(start);
    expect(DEFAULT_HELP.slice(start, end)).toContain('--dry-run');
  });

  it('eject row mentions checklist or manual steps', () => {
    expect(DEFAULT_HELP).toMatch(/checklist|manual/i);
  });
});
