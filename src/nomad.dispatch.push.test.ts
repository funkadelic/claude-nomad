import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// parsePushArgs
// ---------------------------------------------------------------------------

describe('parsePushArgs - boolean flags', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('no flags parses to all defaults', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
    });
  });

  it('--dry-run parses to dryRun=true', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--dry-run']);
    expect(result).toEqual({
      dryRun: true,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
    });
  });

  it('--redact-all parses to redactAll=true', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--redact-all']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: true,
      allowAll: false,
      allowRule: undefined,
    });
  });

  it('--allow-all parses to allowAll=true', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--allow-all']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: true,
      allowRule: undefined,
    });
  });

  it('--dry-run --redact-all is accepted (orthogonal flags)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--dry-run', '--redact-all']);
    expect(result).toEqual({
      dryRun: true,
      redactAll: true,
      allowAll: false,
      allowRule: undefined,
    });
  });

  it('unknown flag returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--bogus'])).toBeNull();
  });

  it('duplicate --dry-run returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--dry-run', '--dry-run'])).toBeNull();
  });

  it('duplicate --redact-all returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--redact-all', '--redact-all'])).toBeNull();
  });
});

describe('parsePushArgs - --allow <rule> value flag', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('--allow <rule> parses to allowRule', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'github-pat']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: false,
      allowRule: 'github-pat',
    });
  });

  it('--allow with no value returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow'])).toBeNull();
  });

  it('--allow with a value starting with -- returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow', '--other-flag'])).toBeNull();
  });

  it('duplicate --allow returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(
      parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'rule-a', '--allow', 'rule-b']),
    ).toBeNull();
  });
});

describe('parsePushArgs - mutual exclusivity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('--allow-all + --redact-all returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow-all', '--redact-all'])).toBeNull();
  });

  it('--allow <rule> + --redact-all returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(
      parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'github-pat', '--redact-all']),
    ).toBeNull();
  });

  it('--allow <rule> + --allow-all returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(
      parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'github-pat', '--allow-all']),
    ).toBeNull();
  });

  it('--allow-all + --dry-run returns null (allow* + dry-run rejected)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow-all', '--dry-run'])).toBeNull();
  });

  it('--allow <rule> + --dry-run returns null (allow* + dry-run rejected)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(
      parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'github-pat', '--dry-run']),
    ).toBeNull();
  });
});
