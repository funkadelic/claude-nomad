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
      fullScan: false,
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
      fullScan: false,
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
      fullScan: false,
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
      fullScan: false,
    });
  });

  it('--full-scan parses to fullScan=true', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--full-scan']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
      fullScan: true,
    });
  });

  it('--full-scan --dry-run both parse (composes freely with dry-run)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--full-scan', '--dry-run']);
    expect(result).toEqual({
      dryRun: true,
      redactAll: false,
      allowAll: false,
      allowRule: undefined,
      fullScan: true,
    });
  });

  it('duplicate --full-scan returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--full-scan', '--full-scan'])).toBeNull();
  });

  it('--dry-run --redact-all returns null (a dry-run resolves nothing)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--dry-run', '--redact-all'])).toBeNull();
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
      fullScan: false,
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

  it('--allow with a single-dash value returns null (leading-dash guard)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow', '-x'])).toBeNull();
  });

  it('--allow with a value containing invalid characters returns null', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'rule id'])).toBeNull();
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'a/b'])).toBeNull();
  });

  it('--allow accepts a well-formed rule id with underscores and hyphens', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    expect(parsePushArgs(['node', 'nomad.ts', 'push', '--allow', 'generic_api-key'])).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: false,
      allowRule: 'generic_api-key',
      fullScan: false,
    });
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

  it('--full-scan + --redact-all parses (--full-scan is not a resolution mode)', async () => {
    // --full-scan must NOT enter the resolution-mode mutual-exclusion check.
    // It should compose freely with all resolution modes.
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--full-scan', '--redact-all']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: true,
      allowAll: false,
      allowRule: undefined,
      fullScan: true,
    });
  });

  it('--full-scan + --allow-all parses (--full-scan is not a resolution mode)', async () => {
    const { parsePushArgs } = await import('./nomad.dispatch.push.ts');
    const result = parsePushArgs(['node', 'nomad.ts', 'push', '--full-scan', '--allow-all']);
    expect(result).toEqual({
      dryRun: false,
      redactAll: false,
      allowAll: true,
      allowRule: undefined,
      fullScan: true,
    });
  });
});
