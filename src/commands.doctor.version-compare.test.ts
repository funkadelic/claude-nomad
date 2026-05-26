import { describe, expect, it } from 'vitest';

describe('compareSemver', () => {
  it('returns 0 for equal MAJOR.MINOR.PATCH', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns 1 when a has a higher major and -1 when lower', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a has a higher minor and -1 when lower (same major)', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.5.0', '1.4.9')).toBe(1);
    expect(compareSemver('1.4.0', '1.5.0')).toBe(-1);
  });

  it('returns 1 when a has a higher patch and -1 when lower (same major/minor)', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('1.0.5', '1.0.4')).toBe(1);
    expect(compareSemver('1.0.4', '1.0.5')).toBe(-1);
  });

  it('returns 0 when either input fails the strict MAJOR.MINOR.PATCH regex', async () => {
    const { compareSemver } = await import('./commands.doctor.version.ts');
    expect(compareSemver('not-semver', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });
});
