import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('absent logical does not crash due to optional chaining (kills L47 OptionalChaining and L48 ConditionalExpression)', async () => {
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
    // Single direct call: a throw here fails the test, covering the no-throw pin.
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

  it('yields a target whose dirname is .claude when extras lists [.claude] (whitelist acceptance)', async () => {
    writeFileSync(
      env.mapPath,
      JSON.stringify({
        projects: { foo: { 'test-host': env.projectRoot } },
        extras: { foo: ['.claude'] },
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
      dirname: '.claude',
    });
    expect(counts.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// copyExtrasFiltered: ALWAYS_NEVER_SYNC filter semantics
// ---------------------------------------------------------------------------

describe('copyExtrasFiltered ALWAYS_NEVER_SYNC filter', () => {
  let tmpSrc: string;
  let tmpDst: string;

  beforeEach(() => {
    tmpSrc = mkdtempSync(join(tmpdir(), 'nomad-core-filter-src-'));
    tmpDst = mkdtempSync(join(tmpdir(), 'nomad-core-filter-dst-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpSrc, { recursive: true, force: true });
    rmSync(tmpDst, { recursive: true, force: true });
  });

  it('excludes settings.local.json and copies settings.json and hooks/foo.cjs', async () => {
    // Build a src tree mirroring a real .claude/ directory.
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-opus-4-5"}\n');
    writeFileSync(join(tmpSrc, 'settings.local.json'), 'secret=1\n');
    mkdirSync(join(tmpSrc, 'hooks'), { recursive: true });
    writeFileSync(join(tmpSrc, 'hooks', 'foo.cjs'), '// hook\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.planning'));

    // Blocked: ALWAYS_NEVER_SYNC entry must not appear in dst.
    expect(existsSync(join(tmpDst, 'settings.local.json'))).toBe(false);
    // Allowed: non-blocked entries must be present.
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
    expect(existsSync(join(tmpDst, 'hooks', 'foo.cjs'))).toBe(true);
  });

  it('allows a todos/ dir under the .planning denylist (NEVER_SYNC-but-not-ALWAYS_NEVER_SYNC)', async () => {
    // todos/ is in NEVER_SYNC but NOT in ALWAYS_NEVER_SYNC; under the .planning
    // (ALWAYS_NEVER_SYNC) denylist it must pass.
    mkdirSync(join(tmpSrc, 'todos'), { recursive: true });
    writeFileSync(join(tmpSrc, 'todos', 'task.md'), '# task\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.planning'));

    expect(existsSync(join(tmpDst, 'todos', 'task.md'))).toBe(true);
  });

  it('allows a plans/ dir under the .planning denylist (another NEVER_SYNC-but-not-ALWAYS name)', async () => {
    mkdirSync(join(tmpSrc, 'plans'), { recursive: true });
    writeFileSync(join(tmpSrc, 'plans', 'roadmap.md'), '# roadmap\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.planning'));

    expect(existsSync(join(tmpDst, 'plans', 'roadmap.md'))).toBe(true);
  });

  it('strips NEVER_SYNC-only names under the .claude denylist while keeping config', async () => {
    // The .claude extra uses the full NEVER_SYNC boundary: ephemeral host-local
    // names (todos/, shell-snapshots/, sessions/) must be stripped, while config
    // (settings.json, hooks/) survives.
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-opus-4-5"}\n');
    mkdirSync(join(tmpSrc, 'hooks'), { recursive: true });
    writeFileSync(join(tmpSrc, 'hooks', 'foo.cjs'), '// hook\n');
    mkdirSync(join(tmpSrc, 'todos'), { recursive: true });
    writeFileSync(join(tmpSrc, 'todos', 'task.md'), '# task\n');
    mkdirSync(join(tmpSrc, 'shell-snapshots'), { recursive: true });
    writeFileSync(join(tmpSrc, 'shell-snapshots', 'snap.sh'), 'export X=1\n');
    mkdirSync(join(tmpSrc, 'sessions'), { recursive: true });
    writeFileSync(join(tmpSrc, 'sessions', 's.json'), '{}\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.claude'));

    // Stripped: NEVER_SYNC names that the narrow ALWAYS_NEVER_SYNC subset misses.
    expect(existsSync(join(tmpDst, 'todos'))).toBe(false);
    expect(existsSync(join(tmpDst, 'shell-snapshots'))).toBe(false);
    expect(existsSync(join(tmpDst, 'sessions'))).toBe(false);
    // Kept: config content.
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
    expect(existsSync(join(tmpDst, 'hooks', 'foo.cjs'))).toBe(true);
  });

  it('filters a denied basename nested below the top level (depth, not just root)', async () => {
    // The security claim is "blocked at any depth"; prove the basename filter
    // fires on a nested entry, not only at the source root.
    mkdirSync(join(tmpSrc, 'sub'), { recursive: true });
    writeFileSync(join(tmpSrc, 'sub', 'settings.local.json'), 'secret=1\n');
    writeFileSync(join(tmpSrc, 'sub', 'keep.json'), '{"ok":1}\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'sub', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(tmpDst, 'sub', 'keep.json'))).toBe(true);
  });

  it('keeps the root src entry even when its basename is a denied name', async () => {
    // The denylist applies to contents, not the source dir. A src dir whose own
    // basename collides with a denied name (e.g. todos/) must still be mirrored,
    // not silently produce an empty dst.
    const deniedRoot = join(tmpSrc, 'todos');
    mkdirSync(deniedRoot, { recursive: true });
    writeFileSync(join(deniedRoot, 'inner.md'), '# inner\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(deniedRoot, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'inner.md'))).toBe(true);
  });

  it('extrasDenySet returns CLAUDE_EXTRA_NEVER_SYNC for .claude and ALWAYS_NEVER_SYNC for others', async () => {
    const { extrasDenySet } = await import('./extras-sync.core.ts');
    const { CLAUDE_EXTRA_NEVER_SYNC, ALWAYS_NEVER_SYNC } = await import('./config.ts');
    expect(extrasDenySet('.claude')).toBe(CLAUDE_EXTRA_NEVER_SYNC);
    expect(extrasDenySet('.planning')).toBe(ALWAYS_NEVER_SYNC);
    expect(extrasDenySet('CLAUDE.md')).toBe(ALWAYS_NEVER_SYNC);
  });

  it('strips a projects/ dir under the .claude denylist (session transcripts, not in base NEVER_SYNC)', async () => {
    // `projects` is absent from NEVER_SYNC (mapped projects sync transcripts via
    // the path-remap mechanism), but the .claude extra must still strip a raw
    // projects/ dir so transcripts never ride through the extras gate.
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-opus-4-5"}\n');
    mkdirSync(join(tmpSrc, 'projects', 'enc'), { recursive: true });
    writeFileSync(join(tmpSrc, 'projects', 'enc', 'transcript.jsonl'), '{"secret":1}\n');

    const { copyExtrasFiltered, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFiltered(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'projects'))).toBe(false);
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
  });

  it('unfiltered copyExtras still copies settings.local.json (original behavior unchanged)', async () => {
    writeFileSync(join(tmpSrc, 'settings.local.json'), 'secret=1\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-sonnet-4-6"}\n');

    const { copyExtras } = await import('./extras-sync.core.ts');
    copyExtras(tmpSrc, tmpDst);

    // copyExtras is unfiltered; the blocked file must still appear in dst.
    expect(existsSync(join(tmpDst, 'settings.local.json'))).toBe(true);
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// copyExtrasFilteredPreserving: pull-only preserving copy semantics
// ---------------------------------------------------------------------------

describe('copyExtrasFilteredPreserving pull-only preserving copy', () => {
  let tmpSrc: string;
  let tmpDst: string;
  // An out-of-tree dir created by the symlink-root test; cleaned unconditionally
  // in afterEach so a failed assertion cannot leak it.
  let tmpExternal: string | undefined;

  beforeEach(() => {
    tmpSrc = mkdtempSync(join(tmpdir(), 'nomad-core-pres-src-'));
    tmpDst = mkdtempSync(join(tmpdir(), 'nomad-core-pres-dst-'));
    tmpExternal = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpSrc, { recursive: true, force: true });
    rmSync(tmpDst, { recursive: true, force: true });
    if (tmpExternal !== undefined) rmSync(tmpExternal, { recursive: true, force: true });
  });

  it('Test A (regression): preserves a deny-set dst file absent from src', async () => {
    // The core bug: settings.local.json lives on the host dst but is absent from
    // the repo src (push filtered it out). After a pull it must still exist.
    writeFileSync(join(tmpDst, 'settings.local.json'), 'host-local=1\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-opus-4-5"}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'settings.local.json'))).toBe(true);
    expect(readFileSync(join(tmpDst, 'settings.local.json'), 'utf8')).toBe('host-local=1\n');
  });

  it('Test B (true-mirror deletion): removes a non-deny dst file absent from src', async () => {
    // A synced file that was removed from the repo must be pruned from dst.
    writeFileSync(join(tmpDst, 'stale.json'), 'old=1\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"claude-opus-4-5"}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'stale.json'))).toBe(false);
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
  });

  it('Test C (overwrite synced file): overwrites a non-deny file present in both src and dst', async () => {
    writeFileSync(join(tmpDst, 'settings.json'), '{"model":"old"}\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"new"}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(readFileSync(join(tmpDst, 'settings.json'), 'utf8')).toBe('{"model":"new"}\n');
  });

  it('Test D (filter applies to src): a deny-set file in src is NOT copied to dst', async () => {
    // Even if the repo were poisoned and contained settings.local.json, the
    // filter must strip it from the copy (defense-in-depth).
    writeFileSync(join(tmpSrc, 'settings.local.json'), 'secret=1\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"x"}\n');
    // dst does NOT have settings.local.json pre-existing.
    rmSync(join(tmpDst, 'settings.local.json'), { force: true });

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'settings.local.json'))).toBe(false);
    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
  });

  it('Test E (fresh pull): dst does not exist before the call; function copies filtered src content', async () => {
    rmSync(tmpDst, { recursive: true, force: true });
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"fresh"}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    expect(() =>
      copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude')),
    ).not.toThrow();

    expect(existsSync(join(tmpDst, 'settings.json'))).toBe(true);
    expect(readFileSync(join(tmpDst, 'settings.json'), 'utf8')).toBe('{"model":"fresh"}\n');
  });

  it('Test F (root src entry kept): src whose own basename is denied is still mirrored', async () => {
    // The srcEntry === src predicate branch: the root src is always kept even
    // when its basename collides with a blocked name.
    const deniedRoot = join(tmpSrc, 'todos');
    mkdirSync(deniedRoot, { recursive: true });
    writeFileSync(join(deniedRoot, 'inner.md'), '# inner\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(deniedRoot, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'inner.md'))).toBe(true);
  });

  it('Test G (non-deny file present in both): overwritten by copy, not removed in prune pass', async () => {
    // The prune pass skips a dst entry that also exists in src (the
    // existsSync(join(src, name)) branch). It stays and is then overwritten.
    writeFileSync(join(tmpDst, 'settings.json'), '{"model":"old"}\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"model":"updated"}\n');
    // Also add a host-local deny-set file to cover the blockSet.has branch.
    writeFileSync(join(tmpDst, 'settings.local.json'), 'local=1\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    // Non-deny file in both: overwritten with src content.
    expect(readFileSync(join(tmpDst, 'settings.json'), 'utf8')).toBe('{"model":"updated"}\n');
    // Deny-set file: preserved unchanged.
    expect(readFileSync(join(tmpDst, 'settings.local.json'), 'utf8')).toBe('local=1\n');
  });

  it('Test WR-01 (recursive prune): a nested non-deny file absent from src is removed', async () => {
    // The prune mirrors at depth, not just the top level: a synced file removed
    // from the repo under a shared subdir must be pruned from dst.
    mkdirSync(join(tmpDst, 'hooks'), { recursive: true });
    writeFileSync(join(tmpDst, 'hooks', 'stale.cjs'), 'old\n');
    mkdirSync(join(tmpSrc, 'hooks'), { recursive: true });
    writeFileSync(join(tmpSrc, 'hooks', 'new.cjs'), 'new\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(existsSync(join(tmpDst, 'hooks', 'stale.cjs'))).toBe(false);
    expect(existsSync(join(tmpDst, 'hooks', 'new.cjs'))).toBe(true);
  });

  it('Test WR-02 (type change): a dst directory is replaced by a same-named src file', async () => {
    // dst has a non-empty dir, src has a regular file at the same name. The prune
    // removes the dst dir on the type mismatch so cpSync can write the file
    // (cpSync cannot overwrite a non-empty dir with a file).
    mkdirSync(join(tmpDst, 'foo'), { recursive: true });
    writeFileSync(join(tmpDst, 'foo', 'inner.txt'), 'x\n');
    writeFileSync(join(tmpSrc, 'foo'), 'file-content\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    expect(() =>
      copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude')),
    ).not.toThrow();

    expect(statSync(join(tmpDst, 'foo')).isFile()).toBe(true);
    expect(readFileSync(join(tmpDst, 'foo'), 'utf8')).toBe('file-content\n');
  });

  it('Test WR-02 (type change, reverse): a dst file is replaced by a same-named src directory', async () => {
    // Mirror of the above: dst is a file, src is a directory at the same name.
    writeFileSync(join(tmpDst, 'bar'), 'old-file\n');
    mkdirSync(join(tmpSrc, 'bar'), { recursive: true });
    writeFileSync(join(tmpSrc, 'bar', 'inner.txt'), 'inner\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    expect(() =>
      copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude')),
    ).not.toThrow();

    expect(statSync(join(tmpDst, 'bar')).isDirectory()).toBe(true);
    expect(existsSync(join(tmpDst, 'bar', 'inner.txt'))).toBe(true);
  });

  it('Test IN-01 (nested deny-set): preserves a deny-set file nested under a shared subdir', async () => {
    // The exact data-loss class the fix targets, at depth: a host-local
    // settings.local.json under a shared subdir must survive the pull.
    mkdirSync(join(tmpDst, 'sub'), { recursive: true });
    writeFileSync(join(tmpDst, 'sub', 'settings.local.json'), 'host=1\n');
    mkdirSync(join(tmpSrc, 'sub'), { recursive: true });
    writeFileSync(join(tmpSrc, 'sub', 'keep.json'), '{"a":1}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, tmpDst, extrasDenySet('.claude'));

    expect(readFileSync(join(tmpDst, 'sub', 'settings.local.json'), 'utf8')).toBe('host=1\n');
    expect(existsSync(join(tmpDst, 'sub', 'keep.json'))).toBe(true);
  });

  it('Test root guard (file): a dst that is a regular file is replaced by the mirrored src dir', async () => {
    // A non-directory root must be removed wholesale so cpSync recreates it,
    // rather than readdirSync throwing ENOTDIR on the file.
    const dstFile = join(tmpDst, 'asfile');
    writeFileSync(dstFile, 'i am a file\n');
    writeFileSync(join(tmpSrc, 'settings.json'), '{"a":1}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    expect(() =>
      copyExtrasFilteredPreserving(tmpSrc, dstFile, extrasDenySet('.claude')),
    ).not.toThrow();

    expect(statSync(dstFile).isDirectory()).toBe(true);
    expect(existsSync(join(dstFile, 'settings.json'))).toBe(true);
  });

  it('Test root guard (symlink): does not delete through a dst symlink to an external dir', async () => {
    // If dst is a symlink to a dir, the prune must NOT follow it and delete the
    // target's contents. The root is replaced by a real mirrored dir; the
    // external tree is left untouched.
    const external = mkdtempSync(join(tmpdir(), 'nomad-core-pres-ext-'));
    tmpExternal = external; // afterEach removes it even if an assertion below fails
    writeFileSync(join(external, 'keep.txt'), 'precious\n');
    const dstLink = join(tmpDst, 'link');
    symlinkSync(external, dstLink);
    writeFileSync(join(tmpSrc, 'settings.json'), '{"a":1}\n');

    const { copyExtrasFilteredPreserving, extrasDenySet } = await import('./extras-sync.core.ts');
    copyExtrasFilteredPreserving(tmpSrc, dstLink, extrasDenySet('.claude'));

    // External content survives (no readdir-follow delete).
    expect(existsSync(join(external, 'keep.txt'))).toBe(true);
    // dst link replaced by a real dir holding the mirrored config.
    expect(statSync(dstLink).isDirectory()).toBe(true);
    expect(existsSync(join(dstLink, 'settings.json'))).toBe(true);
  });
});
