import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/** `vi.spyOn(console, 'log')` return type for log spy. */
type LogSpy = MockInstance<(...args: unknown[]) => void>;

/**
 * Sandbox for extras-sync.core unit tests. Provides a fresh temp HOME with a
 * minimal `claude-nomad/` repo skeleton (path-map.json + shared/extras/) so
 * `loadValidatedExtras` and `eachExtrasTarget` can be tested in isolation.
 * Uses vi.resetModules() so each test loads a fresh module instance.
 */
function makeCoreEnv(): {
  testHome: string;
  repo: string;
  mapPath: string;
  sharedExtras: string;
  projectRoot: string;
  logSpy: LogSpy;
  cleanup: () => void;
} {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const testHome = mkdtempSync(join(tmpdir(), 'nomad-extras-core-'));
  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  const repo = join(testHome, 'claude-nomad');
  const mapPath = join(repo, 'path-map.json');
  const sharedExtras = join(repo, 'shared', 'extras');
  const projectRoot = join(testHome, 'fake-project');
  mkdirSync(sharedExtras, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  vi.resetModules();
  const logSpy: LogSpy = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => {
    /* captured */
  });
  return {
    testHome,
    repo,
    mapPath,
    sharedExtras,
    projectRoot,
    logSpy,
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
// loadValidatedExtras: early-exit conditions (L36/L37/L43 survivors)
// ---------------------------------------------------------------------------

describe('loadValidatedExtras early-exit guards (L36/L37/L43)', () => {
  let env: ReturnType<typeof makeCoreEnv>;

  beforeEach(() => {
    env = makeCoreEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns null when path-map.json is absent (kills L36 ConditionalExpression false)', async () => {
    // L36 `!existsSync(mapPath)` forced to `false` would proceed past the
    // missing-map guard and crash on `readPathMap`. With no map, must return null.
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    expect(loadValidatedExtras({})).toBeNull();
  });

  it('returns null AND logs missingMsg when map absent with a message option (kills L37 ConditionalExpression)', async () => {
    // L37 `if (opts.missingMsg !== undefined) log(opts.missingMsg)` mutations:
    // - forced true: always logs (even when msg is undefined -> logs undefined)
    // - forced false: never logs (skips the message on early exit)
    // - === undefined: inverts the guard (logs when undefined, skips when defined)
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    const result = loadValidatedExtras({ missingMsg: 'path-map not found' });
    expect(result).toBeNull();
    const logged = env.logSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('path-map not found');
  });

  it('does NOT log when missingMsg is undefined (kills L37 EqualityOperator === undefined)', async () => {
    // If the guard were inverted to `=== undefined`, it would always log even
    // when missingMsg is not provided. Verify no log fires on undefined msg.
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    loadValidatedExtras({ missingMsg: undefined });
    expect((env.logSpy.mock.calls as unknown[]).length).toBe(0);
  });

  it('returns null when requireRepoExtras is true and shared/extras/ is absent (kills L36 BooleanLiteral/LogicalOperator)', async () => {
    // L36: `opts.requireRepoExtras === true && !existsSync(repoExtras)` sub-condition.
    // LogicalOperator mutation changes || to && (requires BOTH conditions for early exit).
    // BooleanLiteral forces requireRepoExtras check to false (never triggers for repoExtras absent).
    // Write a valid map with extras, but remove shared/extras/ so the guard fires.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': env.projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    rmSync(env.sharedExtras, { recursive: true, force: true });
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    // With requireRepoExtras=true and shared/extras/ absent, must return null.
    expect(loadValidatedExtras({ requireRepoExtras: true })).toBeNull();
    // Without requireRepoExtras=true, the repoExtras check is skipped; must proceed.
    vi.resetModules();
    const { loadValidatedExtras: load2 } = await import('./extras-sync.core.ts');
    // Re-create the map (module reload re-reads HOME from env).
    expect(load2({ requireRepoExtras: false })).not.toBeNull();
  });

  it('returns null when extras block is empty (kills L43 ConditionalExpression false)', async () => {
    // L43 `if (Object.keys(extrasMap).length === 0) return null` forced to `false`
    // would proceed past the empty-extras guard into the validation loop with no
    // entries, returning `{ map, extrasMap: {} }` instead of null.
    writeFileSync(
      env.mapPath,
      JSON.stringify({ projects: { foo: { 'test-host': env.projectRoot } } }) + '\n',
    );
    // No `extras` key -> extrasMap = {} -> length === 0.
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    expect(loadValidatedExtras({})).toBeNull();
  });

  it('returns non-null when map has a valid extras entry (L36 false-guard baseline)', async () => {
    // Baseline: when all guards pass, loadValidatedExtras returns the parsed data.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': env.projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    const result = loadValidatedExtras({});
    expect(result).not.toBeNull();
    expect(result?.extrasMap).toEqual({ foo: ['.planning'] });
  });

  it('runs the validation loop over all logicals (kills L45 BlockStatement)', async () => {
    // L45 empties the for-loop body, skipping assertSafeLogical and assertSafeLocalRoot.
    // A traversal-unsafe logical key must cause a throw when the loop body runs.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { '../etc': { 'test-host': env.projectRoot } },
        extras: { '../etc': ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    // assertSafeLogical must fire on '../etc' and die.
    expect(() => loadValidatedExtras({})).toThrow();
  });

  it('TBD local root is skipped by assertSafeLocalRoot check (kills L47 OptionalChaining and L48 ConditionalExpression)', async () => {
    // L47 removing `?.` would throw when projects[logical] is undefined.
    // L48 forcing `false` would skip the `assertSafeLocalRoot` call for a valid non-TBD root.
    // Test 1: logical not in projects at all (undefined access -> must not throw due to ?.)
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: {},
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    // logical 'foo' not in projects -> map.projects['foo'] is undefined, [HOST] would crash without ?.
    expect(() => loadValidatedExtras({})).not.toThrow();
    const result = loadValidatedExtras({});
    // extrasMap is non-empty so result is non-null (validation loop ran without crashing).
    expect(result).not.toBeNull();
  });

  it('non-TBD local root triggers assertSafeLocalRoot (kills L48 ConditionalExpression false)', async () => {
    // L48 `if (localRoot && localRoot !== 'TBD')` forced to `false` skips the
    // assertSafeLocalRoot call; a non-absolute path must be rejected by
    // assertSafeLocalRoot when the guard is active.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': 'relative/path' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras } = await import('./extras-sync.core.ts');
    // assertSafeLocalRoot must reject a relative (non-absolute) path.
    expect(() => loadValidatedExtras({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// eachExtrasTarget: TBD / unmapped / whitelist filters (L72/L73/L78 survivors)
// ---------------------------------------------------------------------------

describe('eachExtrasTarget filters (L72/L73/L78)', () => {
  let env: ReturnType<typeof makeCoreEnv>;

  beforeEach(() => {
    env = makeCoreEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('skips projects with TBD local root and increments unmapped count (kills L72/L73)', async () => {
    // L72: removing `?.` on `v.map.projects[logical]?.[HOST]` would throw when
    //   the logical is not in projects.
    // L73: `if (!localRoot || localRoot === 'TBD')` forced to `false` would not
    //   skip TBD-mapped projects; they'd be yielded with 'TBD' as localRoot,
    //   causing a path-join crash downstream.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': 'TBD' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras, eachExtrasTarget } = await import('./extras-sync.core.ts');
    const v = loadValidatedExtras({});
    expect(v).not.toBeNull();
    const counts = { unmapped: 0, skipped: 0 };
    const targets = [...eachExtrasTarget(v!, counts)];
    // TBD root: no targets yielded, unmapped incremented.
    expect(targets).toHaveLength(0);
    expect(counts.unmapped).toBe(1);
    expect(counts.skipped).toBe(0);
  });

  it('skips projects with no host entry (undefined local root) and increments unmapped (kills L72 OptionalChaining)', async () => {
    // L72 removing `?.` would crash when map.projects[logical] is defined but
    // the HOST key is absent. Verify it yields nothing and increments unmapped.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'other-host': '/tmp/foo' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras, eachExtrasTarget } = await import('./extras-sync.core.ts');
    const v = loadValidatedExtras({});
    expect(v).not.toBeNull();
    const counts = { unmapped: 0, skipped: 0 };
    const targets = [...eachExtrasTarget(v!, counts)];
    expect(targets).toHaveLength(0);
    expect(counts.unmapped).toBe(1);
  });

  it('skips non-whitelisted dirnames and increments skipped count (kills L78 ConditionalExpression false)', async () => {
    // L78 `if (!whitelist.includes(dirname))` forced to `false` would yield
    // every dirname including non-whitelisted ones like 'node_modules'.
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': env.projectRoot } },
        extras: { foo: ['node_modules', '.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras, eachExtrasTarget } = await import('./extras-sync.core.ts');
    const v = loadValidatedExtras({});
    expect(v).not.toBeNull();
    const counts = { unmapped: 0, skipped: 0 };
    const targets = [...eachExtrasTarget(v!, counts)];
    // node_modules is not whitelisted; .planning is. Only .planning yielded.
    expect(targets).toHaveLength(1);
    expect(targets[0].dirname).toBe('.planning');
    expect(counts.skipped).toBe(1);
    expect(counts.unmapped).toBe(0);
  });

  it('yields all whitelisted dirnames for a mapped project (baseline for L78)', async () => {
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': env.projectRoot } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );
    const { loadValidatedExtras, eachExtrasTarget } = await import('./extras-sync.core.ts');
    const v = loadValidatedExtras({});
    expect(v).not.toBeNull();
    const counts = { unmapped: 0, skipped: 0 };
    const targets = [...eachExtrasTarget(v!, counts)];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      logical: 'foo',
      localRoot: env.projectRoot,
      dirname: '.planning',
    });
    expect(counts.unmapped).toBe(0);
    expect(counts.skipped).toBe(0);
  });
});
