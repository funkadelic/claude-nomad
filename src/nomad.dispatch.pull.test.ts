import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// parsePullArgs
// ---------------------------------------------------------------------------

describe('parsePullArgs - boolean flags', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('no flags parses to all defaults', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    const result = parsePullArgs(['node', 'nomad', 'pull']);
    expect(result).toEqual({ dryRun: false, forceRemote: false });
  });

  it('--dry-run parses to dryRun=true', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    const result = parsePullArgs(['node', 'nomad', 'pull', '--dry-run']);
    expect(result).toEqual({ dryRun: true, forceRemote: false });
  });

  it('--force-remote parses to forceRemote=true', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    const result = parsePullArgs(['node', 'nomad', 'pull', '--force-remote']);
    expect(result).toEqual({ dryRun: false, forceRemote: true });
  });

  it('--dry-run --force-remote returns null (contradiction)', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--dry-run', '--force-remote'])).toBeNull();
  });

  it('--force-remote --dry-run returns null (order independent)', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--force-remote', '--dry-run'])).toBeNull();
  });

  it('duplicate --dry-run returns null', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--dry-run', '--dry-run'])).toBeNull();
  });

  it('duplicate --force-remote returns null', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--force-remote', '--force-remote'])).toBeNull();
  });

  it('unknown token returns null', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--unknown'])).toBeNull();
  });

  it('known flag then unknown token returns null', async () => {
    const { parsePullArgs } = await import('./nomad.dispatch.pull.ts');
    expect(parsePullArgs(['node', 'nomad', 'pull', '--dry-run', '--unknown'])).toBeNull();
  });
});
