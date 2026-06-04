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
