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
 * Returns an empty object when `root` does not exist.
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
    const current = JSON.stringify({ a: 1, c: 3 }, null, 2);
    const next = JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2);
    const { diffJsonStrings } = await import('./preview.ts');
    const out = diffJsonStrings(current, next);
    const outputLines = out.split('\n');

    expect(out).toContain('+  "b": 2,');

    const closingBraceLines = outputLines.filter((l) => l === ' }');
    expect(closingBraceLines.length).toBe(1);

    expect(out).not.toContain('-}');
  });
});

describe('previewSettings canonicalization', () => {
  let testDir: string;
  let basePath: string;
  let hostPath: string;
  let settingsPath: string;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    testDir = mkdtempSync(join(tmpdir(), 'nomad-previewsettings-'));
    basePath = join(testDir, 'settings.base.json');
    hostPath = join(testDir, 'host.json');
    settingsPath = join(testDir, 'settings.json');
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('suppresses the diff and notes the rewrite when only key order differs', async () => {
    writeFileSync(basePath, JSON.stringify({ model: 'opus', hooks: {}, statusLine: 1 }, null, 2));
    // current has the same values, different key order.
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: 1, hooks: {}, model: 'opus' }, null, 2),
    );

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    expect(result.diff).toBe('');
    expect(result.notes).toContain(
      'settings.json will be rewritten in canonical key order; no value changes',
    );
  });

  it('still renders a sorted-key diff for a real value change', async () => {
    writeFileSync(basePath, JSON.stringify({ model: 'opus', hooks: {}, statusLine: 1 }, null, 2));
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: 1, hooks: {}, model: 'sonnet' }, null, 2),
    );

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    expect(result.diff).not.toBe('');
    expect(result.diff).toContain('sonnet');
    expect(result.diff).toContain('opus');
    expect(result.notes).not.toContain(
      'settings.json will be rewritten in canonical key order; no value changes',
    );
  });

  it('emits no note when current and merged are byte-identical', async () => {
    writeFileSync(basePath, JSON.stringify({ model: 'opus' }, null, 2));
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    expect(result.diff).toBe('');
    expect(result.notes).not.toContain(
      'settings.json will be rewritten in canonical key order; no value changes',
    );
  });

  it('renders clean when the only delta is gsd-owned hook self-heal churn', async () => {
    // base/merged carry no hooks; current has only a gsd-installed hook entry
    // (re-injected by gsd every session). Both sides strip to the same shape,
    // so the diff must be empty and no canonical-order note fires.
    writeFileSync(basePath, JSON.stringify({ model: 'opus' }, null, 2));
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          hooks: {
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node "$HOME/.claude/hooks/gsd-context-monitor.js"' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    expect(result.diff).toBe('');
    expect(result.notes).not.toContain(
      'settings.json will be rewritten in canonical key order; no value changes',
    );
  });

  it('still shows a genuine non-gsd change while suppressing gsd hook churn', async () => {
    // current differs from merged by a real value change (model) AND a gsd hook
    // entry. Only the real change should render; the gsd churn must be invisible.
    writeFileSync(basePath, JSON.stringify({ model: 'opus' }, null, 2));
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'sonnet',
          hooks: {
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node "$HOME/.claude/hooks/gsd-context-monitor.js"' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    expect(result.diff).not.toBe('');
    expect(result.diff).toContain('sonnet');
    expect(result.diff).toContain('opus');
    expect(result.diff).not.toContain('gsd-context-monitor');
  });

  it('does NOT add malformed-host note when host file is simply absent (L90: && existsSync guard)', async () => {
    // L90: `if (hostOverrides === null && existsSync(hostPath))`
    // When hostPath does not exist, readJsonOrNull returns null (existsSync false
    // path), but the note must NOT fire because the host file is absent, not
    // malformed. A ConditionalExpression-true mutation always fires the note even
    // when hostPath was never created.
    writeFileSync(basePath, JSON.stringify({ model: 'opus' }, null, 2));
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    // hostPath is NOT written (stays absent).

    const { previewSettings } = await import('./preview.ts');
    const result = previewSettings(basePath, hostPath, settingsPath);
    // No malformed-host note when the file simply doesn't exist.
    expect(result.notes.some((n) => n.includes('malformed'))).toBe(false);
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

  it('renders a glyph-free tree with Symlinks, settings.json, Sessions, and Summary sections', async () => {
    // Sandbox: shared/CLAUDE.md exists, ~/.claude/CLAUDE.md is a real file
    // (triggers auto-move). settings.base.json differs by one key. path-map
    // maps foo -> /tmp/foo with a file under shared/projects/foo/.
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

    // No ℹ︎ glyph anywhere on the preview surface.
    expect(joined).not.toContain('ℹ');

    // Symlinks section header.
    expect(joined).toContain('Symlinks');
    // auto-move row (non-symlink CLAUDE.md triggers it).
    expect(joined).toContain('auto-move');
    // create row (every shared link).
    expect(joined).toContain('create');

    // settings.json section header present.
    expect(joined).toContain('settings.json');
    // Raw diff block: - line with sonnet, + line with opus.
    expect(joined).toContain('-');
    expect(joined).toContain('+');
    expect(joined).toContain('sonnet');
    expect(joined).toContain('opus');

    // Sessions section header.
    expect(joined).toContain('Sessions');
    // overwrite row for foo.
    expect(joined).toContain('overwrite');

    // Summary section header present.
    expect(joined).toContain('Summary');
  });

  it('renders the nothing-to-remap note as a glyph-free Sessions row (no path-map.json)', async () => {
    // No path-map.json on disk -> remapPull early-returns; the note must show
    // up as a Sessions tree row, not a bare ℹ︎ line floating above the tree.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    // No info glyph anywhere on the surface.
    expect(joined).not.toContain('ℹ');
    // The note appears under a Sessions section as a tree row (└ connector).
    expect(joined).toContain('Sessions');
    expect(joined).toContain('skipping session remap');
    const noteLine = logs.find((l) => l.includes('skipping session remap'));
    expect(noteLine).toBeDefined();
    expect(noteLine).toMatch(/[├└]/);
  });

  it('does NOT emit ℹ︎ anywhere on this surface', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    expect(logs.join('\n')).not.toContain('ℹ');
  });

  it('verb "diff" produces a plain "clean" (or unmapped on diff) Summary row', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'diff');

    const joined = logs.join('\n');
    // Clean case: no unmapped entries. The plain Summary row is exactly 'clean'.
    expect(joined).toContain('clean');
  });

  it('verb "pull" produces a plain "clean" row in Summary', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    expect(logs.join('\n')).toContain('clean');
  });

  it('Summary row shows "unmapped on diff" when verb is diff and unmapped > 0', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'b.jsonl'), '{"b":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { bar: { 'test-host': 'TBD' } } }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'diff');

    expect(logs.join('\n')).toContain('unmapped on diff');
  });

  it('settings.json section is omitted when diff is empty and no notes', async () => {
    // Pre-write settings.json to the SAME pretty-printed shape computePreview
    // will compute; no notes expected either.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
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

    // The section header should NOT appear when both diff and notes are empty.
    const joined = logs.join('\n');
    expect(joined).not.toContain('settings.json');
  });

  it('settings.json section is present with note when base is missing', async () => {
    // No settings.base.json; computePreview must NOT throw and must show
    // the locked skip note.
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    expect(joined).toContain('settings.json');
    expect(joined).toContain('section skipped (base or current missing)');
    expect(result).toEqual({ unmapped: 0, collisions: 0 });
  });

  it('settings.json section shows malformed-host note without throwing', async () => {
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
    // The malformed-host note may appear in the settings.json section.
    // (No diff since host was ignored and merged == base == same as no-file case)
    expect(logs.join('\n')).toContain('malformed hosts/test-host.json; ignoring overrides');
  });

  it('settings.json section shows malformed-current note without throwing', async () => {
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
    expect(logs.join('\n')).toContain('malformed; skipping diff');
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

  it('Summary row appears exactly once in the output', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    // The plain Summary row no longer carries a 'summary:' prefix; on the
    // empty-path-map clean fixture (default verb pull) the row is exactly 'clean'.
    const summaryLines = logs.filter((l) => l.includes('clean'));
    expect(summaryLines.length).toBe(1);
  });

  it('settings section raw diff block has native +/- prefixes with no tree connectors in diff lines', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet' }, null, 2) + '\n',
    );
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    // The diff lines carry the native leading space/+/- character (indented
    // by two spaces from the raw section).
    expect(joined).toMatch(/ {2}---/);
    expect(joined).toMatch(/ {2}\+\+\+/);
    // The raw settings section items must NOT have tree connectors.
    const diffLines = logs.filter(
      (l) => l.startsWith('  ') && (l.includes('---') || l.includes('+++')),
    );
    expect(diffLines.some((l) => l.includes('├') || l.includes('└'))).toBe(false);
  });
});
