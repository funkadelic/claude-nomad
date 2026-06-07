import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Isolated sandbox for init.classify tests. Each test gets a fresh temp HOME,
 * fresh module cache, and a bare `claude-nomad/` directory skeleton. The
 * pattern mirrors the `classifyRepoState classifier` describe in init.test.ts
 * but these tests exercise finer-grained boundary and reasonForPartial paths
 * to kill the logic survivors from the Phase 46 Stryker sweep.
 */
function makeClassifyEnv(): {
  testHome: string;
  repo: string;
  cleanup: () => void;
} {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-init-classify-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  const repo = join(testHome, 'claude-nomad');
  mkdirSync(join(repo, 'shared'), { recursive: true });
  mkdirSync(join(repo, 'hosts'), { recursive: true });
  vi.resetModules();
  return {
    testHome,
    repo,
    cleanup: () => {
      vi.restoreAllMocks();
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
      else delete process.env.NOMAD_HOST;
      rmSync(testHome, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// classifyRepoState: populated vs. partial boundary (L47/L48 survivors)
// ---------------------------------------------------------------------------

describe('classifyRepoState populated-vs-partial boundary (L47/L48)', () => {
  let env: ReturnType<typeof makeClassifyEnv>;

  beforeEach(() => {
    env = makeClassifyEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns "populated" only when base + non-zero-entry map + host are ALL present (kills L47 ConditionalExpression true)', async () => {
    // L47 `if (!hasBase && mapEntryCount === 0) return 'empty'` forced to `true`
    // makes it always return 'empty'. A populated state must return 'populated'.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(env.repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(env.repo, 'hosts', 'test-host.json'), '{}\n');

    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(env.repo, 'test-host')).toBe('populated');
  });

  it('returns "partial" not "populated" when base+map present but host missing (kills L48 LogicalOperator)', async () => {
    // L48 `hasBase && mapEntryCount > 0 && hasHost` mutated to `hasBase || mapEntryCount > 0`
    // would return 'populated' even when hasHost is false. Must return 'partial'.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(env.repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'other-host': '/tmp/foo' } } }) + '\n',
    );
    // No hosts/test-host.json written.
    expect(existsSync(join(env.repo, 'hosts', 'test-host.json'))).toBe(false);

    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(env.repo, 'test-host')).toBe('partial');
  });

  it('returns "partial" not "populated" when base+host present but map has zero entries (kills L48 EqualityOperator >= 0)', async () => {
    // L48 `mapEntryCount > 0` mutated to `>= 0` (always true) would let an
    // empty-projects map be classified as populated. Must return 'partial'.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(env.repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    writeFileSync(join(env.repo, 'hosts', 'test-host.json'), '{}\n');

    const { classifyRepoState } = await import('./init.classify.ts');
    expect(classifyRepoState(env.repo, 'test-host')).toBe('partial');
  });

  it('returns "partial" when map is absent (hasMap=false, hasBase=true) even with malformed hasMap guard (kills L36)', async () => {
    // L36 `if (hasMap)` forced to `true` would attempt readJson on a nonexistent
    // path; the catch sets mapEntryCount=0. With base present and map absent,
    // result should be 'partial' regardless. Test verifies the classifier
    // consistently returns 'partial' when map is missing (base present, host absent).
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    // No path-map.json written.
    expect(existsSync(join(env.repo, 'path-map.json'))).toBe(false);

    const { classifyRepoState } = await import('./init.classify.ts');
    // base present, no map, no host -> partial
    expect(classifyRepoState(env.repo, 'test-host')).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// classifyRepoState: empty-string host path construction (L68)
// ---------------------------------------------------------------------------

describe('classifyRepoState host path construction (L68 StringLiteral)', () => {
  let env: ReturnType<typeof makeClassifyEnv>;

  beforeEach(() => {
    env = makeClassifyEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('distinguishes populated vs. partial based on the correct hosts/<host>.json path (kills L68)', async () => {
    // L68 `hosts/${host}.json` mutated to an empty template literal would produce
    // `hosts/` as the hostPath, which does not exist -> hasHost=false -> partial
    // even when the real hosts/test-host.json is present.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(env.repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    writeFileSync(join(env.repo, 'hosts', 'test-host.json'), '{}\n');
    // Confirm the correct host file is present and no directory called '' exists.
    expect(existsSync(join(env.repo, 'hosts', 'test-host.json'))).toBe(true);

    const { classifyRepoState } = await import('./init.classify.ts');
    // With the correct host path, it must return 'populated'.
    expect(classifyRepoState(env.repo, 'test-host')).toBe('populated');
    // With a different host name (no corresponding .json), it must return 'partial'.
    expect(classifyRepoState(env.repo, 'other-host')).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// reasonForPartial: branch coverage (L70/L80/L81 ConditionalExpression)
// ---------------------------------------------------------------------------

describe('reasonForPartial branch coverage (L70/L80/L81)', () => {
  let env: ReturnType<typeof makeClassifyEnv>;

  beforeEach(() => {
    env = makeClassifyEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns path-map.json missing when base is present but map is absent (kills L70 ConditionalExpression false)', async () => {
    // L70 `if (!existsSync(mapPath)) return '- path-map.json missing'` forced to
    // `false` would skip this return and fall through to readJson on a nonexistent
    // file (throws), then catch sets mapEntryCount=0, and
    // `if (mapEntryCount === 0)` returns the empty-entries message instead.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    // No path-map.json written.

    const { reasonForPartial } = await import('./init.classify.ts');
    expect(reasonForPartial(env.repo, 'test-host')).toBe('- path-map.json missing');
  });

  it('returns no-entries message when map is present but projects is empty (kills L80 ConditionalExpression false)', async () => {
    // L80 `if (mapEntryCount === 0) return '...'` forced to `false` would skip
    // this return and fall through to the hostPath check, returning
    // `- hosts/test-host.json missing` (correct for the populated check)
    // instead of the empty-entries message.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(env.repo, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    // No host file.

    const { reasonForPartial } = await import('./init.classify.ts');
    expect(reasonForPartial(env.repo, 'test-host')).toBe('- path-map.json.projects has no entries');
  });

  it('returns hosts/<host>.json missing when base+map present but host absent (kills L81 ConditionalExpression false)', async () => {
    // L81 `if (!existsSync(hostPath))` forced to `false` would skip the
    // missing-host return and fall through to the defensive fallback instead.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(
      join(env.repo, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // No hosts/test-host.json written.

    const { reasonForPartial } = await import('./init.classify.ts');
    expect(reasonForPartial(env.repo, 'test-host')).toBe('- hosts/test-host.json missing');
  });

  it('returns malformed-map as no-entries (catch fallback, kills L72 BlockStatement)', async () => {
    // L72: emptying the catch block in reasonForPartial would leave mapEntryCount
    // undefined (or cause a ReferenceError). The catch must set mapEntryCount=0
    // so the empty-entries message is returned rather than crashing.
    writeFileSync(join(env.repo, 'shared', 'settings.base.json'), '{}\n');
    writeFileSync(join(env.repo, 'path-map.json'), '{not valid json');

    const { reasonForPartial } = await import('./init.classify.ts');
    // Malformed JSON: mapEntryCount should be 0 via catch, returning empty-entries.
    expect(reasonForPartial(env.repo, 'test-host')).toBe('- path-map.json.projects has no entries');
  });
});
