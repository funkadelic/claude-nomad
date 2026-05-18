import { describe, expect, it } from 'vitest';

describe('push-checks module exports', () => {
  it('exports findGitlinks, probeGitleaks, runGitleaksScan, rebaseBeforePush', async () => {
    const mod = await import('./push-checks.ts');
    expect(typeof mod.findGitlinks).toBe('function');
    expect(typeof mod.probeGitleaks).toBe('function');
    expect(typeof mod.runGitleaksScan).toBe('function');
    expect(typeof mod.rebaseBeforePush).toBe('function');
  });
});
