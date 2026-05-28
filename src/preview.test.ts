import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recursively snapshot `{ relativePath: fileContent }` for every regular
 * file under `root`. Used to assert that computePreview does NOT mutate any
 * file under `~/.claude/` or `~/.cache/claude-nomad/backup/` between calls.
 * Returns an empty object when `root` does not exist (the dry-run path may
 * intentionally not create the cache dir). Reads directly via readFileSync
 * and recurses on EISDIR instead of stat-then-read so the helper has no
 * check-then-use pattern between sibling fs calls.
 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      try {
        out[relative(root, abs)] = readFileSync(abs, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EISDIR') walk(abs);
        else throw err;
      }
    }
  };
  walk(root);
  return out;
}

describe('diffJsonStrings', () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  });

  it('produces - and + lines for a one-key change with literal prefixes under NO_COLOR', async () => {
    const current = JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2);
    const next = JSON.stringify({ model: 'opus', hooks: {} }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    expect(out).toContain('-');
    expect(out).toContain('+');
    expect(out).toContain('sonnet');
    expect(out).toContain('opus');
    // Under NO_COLOR the prefixes must be literal characters, not ANSI escapes.
    // Picocolors degrades color helpers to identity, so the output has no
    // ANSI CSI prefix (the control byte 0x1b followed by `[`).
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('returns an empty string when the two inputs are byte-identical', async () => {
    const s = JSON.stringify({ model: 'sonnet' }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(s, s);
    expect(out).toBe('');
  });

  it('output starts with the literal header lines', async () => {
    const current = JSON.stringify({ model: 'sonnet' }, null, 2);
    const next = JSON.stringify({ model: 'opus' }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    const outputLines = out.split('\n');
    expect(outputLines[0]).toBe('--- ~/.claude/settings.json');
    expect(outputLines[1]).toBe('+++ would write');
  });

  it('add-only: adds a new key without emitting undefined artifacts', async () => {
    // jsdiff added branch: current is shorter than next; the extra entries in
    // next must appear as + lines and never contain the string 'undefined'.
    const current = JSON.stringify({}, null, 2);
    const next = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    expect(out).not.toContain('undefined');
    expect(out).toContain('+');
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": 2');
  });

  it('remove-only: removes a key without emitting undefined artifacts', async () => {
    // jsdiff removed branch: current is longer than next; the removed entries
    // must appear as - lines and never contain the string 'undefined'.
    const current = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const next = JSON.stringify({}, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    expect(out).not.toContain('undefined');
    expect(out).toContain('-');
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": 2');
  });

  it('mid-document insertion: unchanged tail appears as context, not a -/+ cascade', async () => {
    // The core LCS behavior test. Inserting a key between two existing keys
    // must not cascade -/+ pairs for every following line. The closing brace
    // and any tail lines must appear exactly once as space-prefixed context
    // lines, not duplicated as removed-then-added pairs.
    const current = JSON.stringify({ a: 1, c: 3 }, null, 2);
    const next = JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    const outputLines = out.split('\n');

    // The inserted key must appear as a + line (JSON.stringify indents with 2
    // spaces, so the line is `+  "b": 2,`).
    expect(out).toContain('+  "b": 2,');

    // The unchanged tail (closing brace line) must appear exactly once as a
    // space-prefixed context line, not duplicated as -/+ pairs.
    const closingBraceLines = outputLines.filter((l) => l === ' }');
    expect(closingBraceLines.length).toBe(1);

    // No removed (-) line for the closing brace.
    expect(out).not.toContain('-}');
  });
});

describe('computePreview orchestration', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let originalNoColor: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let claudeDir: string;
  let sharedDir: string;
  let hostsDir: string;
  let sharedProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    testHome = mkdtempSync(join(tmpdir(), 'nomad-preview-test-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedDir = join(repoUnderHome, 'shared');
    hostsDir = join(repoUnderHome, 'hosts');
    sharedProjects = join(sharedDir, 'projects');
    claudeDir = join(testHome, '.claude');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(hostsDir, { recursive: true });
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('emits structured preview lines covering symlinks, settings diff, and projects', async () => {
    // Sandbox: shared/CLAUDE.md exists, ~/.claude/CLAUDE.md is a real (non-symlink)
    // file (would-auto-move surface). settings.base.json differs from the existing
    // settings.json by one key. path-map maps `foo` -> /tmp/foo on this host with
    // a single file under shared/projects/foo/.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
    writeFileSync(
      join(sharedDir, 'settings.base.json'),
      JSON.stringify({ model: 'opus', hooks: {} }) + '\n',
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', hooks: {} }, null, 2) + '\n',
    );
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    // Symlink section: would-create OR would-auto-move
    expect(joined).toMatch(/would create symlink:|would auto-move non-symlink:/);
    // Settings diff section: a - line containing "sonnet" and a + line with "opus"
    expect(joined).toContain('-');
    expect(joined).toContain('+');
    expect(joined).toContain('sonnet');
    expect(joined).toContain('opus');
    // Projects section: would-overwrite line for the foo entry
    expect(joined).toMatch(/would overwrite: .*-tmp-foo/);
  });

  it('does NOT mutate any file under ~/.claude/ or ~/.cache/claude-nomad/backup/', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet' }, null, 2) + '\n',
    );
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const beforeClaude = snapshotTree(claudeDir);
    const cacheRoot = join(testHome, '.cache', 'claude-nomad');
    const backupRoot = join(cacheRoot, 'backup');
    const beforeCache = snapshotTree(cacheRoot);
    // snapshotTree captures file contents only, so an accidental empty-dir
    // create would slip past it. Capture directory existence too so we
    // catch any new ~/.cache/claude-nomad/ or backup/ directory the dry-run
    // path creates as a side effect.
    const cacheExistedBefore = existsSync(cacheRoot);
    const backupExistedBefore = existsSync(backupRoot);

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    const afterClaude = snapshotTree(claudeDir);
    const afterCache = snapshotTree(cacheRoot);
    expect(afterClaude).toEqual(beforeClaude);
    expect(afterCache).toEqual(beforeCache);
    expect(existsSync(cacheRoot)).toBe(cacheExistedBefore);
    expect(existsSync(backupRoot)).toBe(backupExistedBefore);
    // Specifically: the per-run backup dir must not exist.
    expect(existsSync(join(cacheRoot, 'backup', '20260516-000000'))).toBe(false);
  });

  it('returns { unmapped, collisions } aggregated from remapPull', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 's2.jsonl'), '{"s":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': 'TBD' },
        },
      }) + '\n',
    );

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} });

    expect(result.unmapped).toBe(1);
    expect(result.collisions).toBe(0);
  });

  it('skips the settings section with the locked phrasing when shared/settings.base.json is missing', async () => {
    // No settings.base.json. Plus a missing settings.json on the host side.
    // computePreview must tolerate this (offline-safe per cmdDiff contract):
    // no die, no throw; emit the locked skip phrasing and continue.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    expect(joined).toContain('settings.json: section skipped (base or current missing)');
    expect(result).toEqual({ unmapped: 0, collisions: 0 });
  });

  it('emits a no-changes line when the merged settings are byte-identical to current', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    // Pre-write settings.json to the SAME pretty-printed shape computePreview will compute.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus' }, null, 2) + '\n',
    );
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    expect(logs.join('\n')).toContain('settings.json: no changes');
  });

  it('does not die on malformed settings.json; logs a skip-diff message instead', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(claudeDir, 'settings.json'), '{ malformed json');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { computePreview } = await import('./preview.ts');
    expect(() => computePreview('20260516-000000', { projects: {} })).not.toThrow();
    expect(logs.join('\n')).toContain('settings.json: malformed; skipping diff');
  });

  it('does not die on malformed hosts/<HOST>.json; logs an ignore-overrides message instead', async () => {
    // Base parses fine but the per-host override file is malformed. Without
    // the tolerance branch, readJson throws SyntaxError and the dry-run
    // crashes before users see the rest of the preview. Expect a single
    // canonical message and continued execution.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(hostsDir, 'test-host.json'), '{ malformed json');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { computePreview } = await import('./preview.ts');
    expect(() => computePreview('20260516-000000', { projects: {} })).not.toThrow();
    expect(logs.join('\n')).toContain(
      'settings.json: malformed hosts/test-host.json; ignoring overrides',
    );
  });
});
