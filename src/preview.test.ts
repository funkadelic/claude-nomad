import {
  chmodSync,
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

import { stubPlatform } from './test-helpers.platform.ts';

// The "non-win32" test below asserts `process.platform !== 'win32'` directly
// against the real host (no Object.defineProperty override), so it is false
// by construction on an actual win32 runner. The win32 branch it contrasts
// against is already covered by the sibling test above it, which does
// override process.platform.
const isWin = process.platform === 'win32';

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
    expect(closingBraceLines).toHaveLength(1);

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
  let originalNomadRepo: string | undefined;
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
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNoColor = process.env.NO_COLOR;
    // A developer-exported NOMAD_REPO would win over the fixture repo under
    // the temp HOME (repoHome resolves it first), pointing every repoHome()
    // call at the real checkout; clear it so the fixtures are authoritative.
    delete process.env.NOMAD_REPO;
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
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
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
    if (process.platform === 'win32') {
      // No unprivileged symlink support: every entry previews as a single
      // unified "copy" event/wording, with no create/auto-move distinction.
      expect(joined).toContain('would copy');
    } else {
      // auto-move row (non-symlink CLAUDE.md triggers it).
      expect(joined).toContain('auto-move');
      // create row (every shared link).
      expect(joined).toContain('create');
    }

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

  it('surfaces the retained local-only count as a plain Sessions row and a non-clean Summary', async () => {
    // Mapped project foo -> /tmp/foo. Repo has s1.jsonl; the host encoded dir
    // has both s1.jsonl (mirrored) and local-only.jsonl (unpushed). scanLocalOnly
    // must count the one local-only leaf and computePreview must surface it.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    const encodedLocal = join(claudeDir, 'projects', '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 's1.jsonl'), '{"s":1}\n');
    writeFileSync(join(encodedLocal, 'local-only.jsonl'), '{"local":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    // Sessions row names the retained local-only count and the reconcile hint.
    expect(joined).toContain('1 local-only present, not in repo (push to reconcile)');
    // The row is emitted as its own plain-text tree line (no color glyph); the
    // broad glyph-free assertions in the sibling tests cover the surface.
    const localOnlyLine = logs.find((l) => l.includes('local-only present'));
    expect(localOnlyLine).toBeDefined();
    // Summary is no longer 'clean' over an unpushed tree; it names the count.
    expect(joined).toContain('1 local-only present');
    const summaryLines = logs.filter((l) => l.includes('clean'));
    expect(summaryLines).toHaveLength(0);
    // Return shape exposes the honest count for direct assertion.
    expect(result.localOnly).toBe(1);
  });

  it('emits no local-only row and keeps a clean Summary when nothing is local-only', async () => {
    // Mapped project foo -> /tmp/foo, but the host encoded dir mirrors the repo
    // exactly (no unpushed leaf). scanLocalOnly returns 0; Summary stays 'clean'.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    const encodedLocal = join(claudeDir, 'projects', '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 's1.jsonl'), '{"s":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} });

    const joined = logs.join('\n');
    expect(joined).not.toContain('local-only present');
    expect(joined).toContain('clean');
    expect(result.localOnly).toBe(0);
  });

  it('does not mutate the filesystem while surfacing a local-only count', async () => {
    // Seed a local-only leaf, snapshot before/after, assert no write and no
    // backup root creation (read-only scan contract).
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's1.jsonl'), '{"s":1}\n');
    const encodedLocal = join(claudeDir, 'projects', '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'local-only.jsonl'), '{"local":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const beforeClaude = snapshotTree(claudeDir);
    const cacheRoot = join(testHome, '.cache', 'claude-nomad');
    const backupRoot = join(cacheRoot, 'backup');
    const backupExistedBefore = existsSync(backupRoot);

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} });

    expect(snapshotTree(claudeDir)).toEqual(beforeClaude);
    expect(existsSync(backupRoot)).toBe(backupExistedBefore);
    expect(existsSync(join(cacheRoot, 'backup', '20260516-000000'))).toBe(false);
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
    expect(result).toEqual({ unmapped: 0, collisions: 0, localOnly: 0 });
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
    expect(summaryLines).toHaveLength(1);
  });

  it('renders an Extras section listing planned <logical>/<dirname> copies (verb=pull)', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const repoExtrasFoo = join(sharedDir, 'extras', 'foo', '.planning');
    mkdirSync(repoExtrasFoo, { recursive: true });
    writeFileSync(join(repoExtrasFoo, 'PROJECT.md'), '# project\n');
    const localFoo = join(testHome, 'projects', 'foo');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': localFoo } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    const joined = logs.join('\n');
    expect(joined).toContain('Extras');
    expect(joined).toContain('foo/.planning');
  });

  it('renders the same Extras section for verb=diff', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const repoExtrasFoo = join(sharedDir, 'extras', 'foo', '.planning');
    mkdirSync(repoExtrasFoo, { recursive: true });
    writeFileSync(join(repoExtrasFoo, 'PROJECT.md'), '# project\n');
    const localFoo = join(testHome, 'projects', 'foo');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': localFoo } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'diff');

    const joined = logs.join('\n');
    expect(joined).toContain('Extras');
    expect(joined).toContain('foo/.planning');
  });

  it('still shows an extra in the Extras section when the local project has no copy yet', async () => {
    // The host project directory for foo is never created; the dry-run source
    // keys off the repo src existing, not the local dst.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const repoExtrasFoo = join(sharedDir, 'extras', 'foo', '.planning');
    mkdirSync(repoExtrasFoo, { recursive: true });
    writeFileSync(join(repoExtrasFoo, 'PROJECT.md'), '# project\n');
    const localFoo = join(testHome, 'never-created', 'foo');
    expect(existsSync(localFoo)).toBe(false);
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': localFoo } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    expect(logs.join('\n')).toContain('foo/.planning');
    expect(existsSync(localFoo)).toBe(false);
  });

  it('omits the Extras header when path-map has no extras key', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    const joined = logs.join('\n');
    expect(joined).not.toMatch(/^Extras$/m);
  });

  it('threads the real extras-skipped count into the Summary row', async () => {
    // 'not-whitelisted' is not in SUPPORTED_EXTRAS, so eachExtrasTarget counts
    // it as skipped rather than yielding a target.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedDir, 'extras'), { recursive: true });
    const localFoo = join(testHome, 'projects', 'foo');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': localFoo } },
        extras: { foo: ['not-whitelisted'] },
      }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    expect(logs.join('\n')).toContain('extras skipped');
  });

  it('combines session-unmapped and extras-unmapped in the Summary row like the wet pull', async () => {
    // foo is keyed to another host: remapPull counts it session-unmapped (1)
    // and remapExtrasPull counts its extras entry unmapped (1). The wet pull
    // Summary reads '2 unmapped on pull' for this state; the preview must
    // match instead of under-reporting with the session count alone.
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    mkdirSync(join(sharedDir, 'extras'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { otherhost: '/x' } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    const result = computePreview('20260516-000000', { projects: {} }, 'pull');

    expect(logs.join('\n')).toContain('2 unmapped on pull');
    // The returned unmapped field stays session-only by contract.
    expect(result.unmapped).toBe(1);
  });

  it('computePreview mutates no file under CLAUDE_HOME, backup base, or the project dir with extras configured', async () => {
    writeFileSync(join(sharedDir, 'settings.base.json'), JSON.stringify({ model: 'opus' }) + '\n');
    const repoExtrasFoo = join(sharedDir, 'extras', 'foo', '.planning');
    mkdirSync(repoExtrasFoo, { recursive: true });
    writeFileSync(join(repoExtrasFoo, 'PROJECT.md'), '# project\n');
    const localFoo = join(testHome, 'projects', 'foo');
    mkdirSync(localFoo, { recursive: true });
    writeFileSync(join(localFoo, 'existing.md'), '# existing\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { foo: { 'test-host': localFoo } },
        extras: { foo: ['.planning'] },
      }) + '\n',
    );

    const beforeClaude = snapshotTree(claudeDir);
    const beforeProject = snapshotTree(localFoo);
    const cacheRoot = join(testHome, '.cache', 'claude-nomad');
    const beforeCache = snapshotTree(cacheRoot);

    const { computePreview } = await import('./preview.ts');
    computePreview('20260516-000000', { projects: {} }, 'pull');

    expect(snapshotTree(claudeDir)).toEqual(beforeClaude);
    expect(snapshotTree(localFoo)).toEqual(beforeProject);
    expect(snapshotTree(cacheRoot)).toEqual(beforeCache);
    expect(existsSync(join(localFoo, '.planning'))).toBe(false);
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

  it('renders "would copy" (not "create") for the Symlinks section on a win32 dry-run', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const realPlatform = process.platform;
    stubPlatform('win32');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const { computePreview } = await import('./preview.ts');
      computePreview('20260516-000000', { projects: {} }, 'pull');
    } finally {
      stubPlatform(realPlatform);
    }

    const joined = logs.join('\n');
    expect(joined).toContain('would copy');
    expect(joined).not.toContain('would create symlink');
    expect(joined).not.toMatch(/^create /m);
  });

  it.skipIf(isWin)(
    'renders the symlink-create line unchanged on a non-win32 dry-run (no regression)',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
      writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

      expect(process.platform).not.toBe('win32');
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });

      const { computePreview } = await import('./preview.ts');
      computePreview('20260516-000000', { projects: {} }, 'pull');

      const joined = logs.join('\n');
      expect(joined).toContain('create');
      expect(joined).not.toContain('would copy');
    },
  );

  /** Plant a shared-links baseline by hand, matching links.deletions.test.ts. */
  function plantBaseline(files: Record<string, unknown>): void {
    const cacheDir = join(testHome, '.cache', 'claude-nomad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'shared-baseline-test-host.json'),
      JSON.stringify({
        schema: 1,
        scannerVersion: 'shared-links-baseline/1',
        configHash: 'not-applicable',
        files,
      }) + '\n',
    );
  }

  it('renders would-capture and would-remove rows on a win32 dry-run, matching the wet predicates', async () => {
    // Capture candidate: local CLAUDE.md differs from the pre-existing shared copy.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-old\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-new\n');

    // Removal candidate: baseline says commands/gone.md was synced to this
    // host; it is now absent locally but still present in the repo.
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'gone.md'), '# gone\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    plantBaseline({ 'commands/gone.md': { size: 1, mtime: 1, hash: 'x' } });

    const realPlatform = process.platform;
    stubPlatform('win32');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const { computePreview } = await import('./preview.ts');
      computePreview('20260803-000000', { projects: {} });
    } finally {
      stubPlatform(realPlatform);
    }

    const joined = logs.join('\n');
    expect(joined).toContain('would capture');
    expect(joined).toMatch(/would capture.*CLAUDE\.md/);
    expect(joined).toContain('would remove');
    expect(joined).toMatch(/would remove.*gone\.md/);
  });

  it('mutates nothing and writes no baseline on a win32 dry-run with a pending capture and removal', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-old\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-new\n');
    mkdirSync(join(sharedDir, 'commands'), { recursive: true });
    writeFileSync(join(sharedDir, 'commands', 'gone.md'), '# gone\n');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    plantBaseline({ 'commands/gone.md': { size: 1, mtime: 1, hash: 'x' } });

    const cacheRoot = join(testHome, '.cache', 'claude-nomad');
    const beforeShared = snapshotTree(sharedDir);
    const beforeClaude = snapshotTree(claudeDir);
    const beforeCache = snapshotTree(cacheRoot);

    const realPlatform = process.platform;
    stubPlatform('win32');
    try {
      const { computePreview } = await import('./preview.ts');
      computePreview('20260803-000001', { projects: {} });
    } finally {
      stubPlatform(realPlatform);
    }

    expect(snapshotTree(sharedDir)).toEqual(beforeShared);
    expect(snapshotTree(claudeDir)).toEqual(beforeClaude);
    // The planted baseline file (and nothing else) is the only file under the
    // cache dir, and it stays byte-identical: the preview reads it but never
    // writes writeSharedBaseline's own record.
    expect(snapshotTree(cacheRoot)).toEqual(beforeCache);
  });

  it('under a win32 dry-run capture, leaves the repo-side file byte-unchanged and creates no backup directory', async () => {
    // Now that the Symlinks capture row is sourced from the real mirror
    // (stageLocalSharedEdits under dryRun) instead of a read-only predictor,
    // this asserts the dryRun contract directly rather than assuming it: a
    // regression here would turn the read-only `nomad diff` into a writer.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-old\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-new\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');

    const realPlatform = process.platform;
    stubPlatform('win32');
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    try {
      const { computePreview } = await import('./preview.ts');
      computePreview('20260810-000010', { projects: {} });
    } finally {
      stubPlatform(realPlatform);
    }

    expect(readFileSync(join(sharedDir, 'CLAUDE.md'), 'utf8')).toBe('# shared-old\n');
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260810-000010');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('writes no shared-links baseline file when none existed before a win32 dry-run', async () => {
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-old\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-new\n');
    const baselinePath = join(testHome, '.cache', 'claude-nomad', 'shared-baseline-test-host.json');
    expect(existsSync(baselinePath)).toBe(false);

    const realPlatform = process.platform;
    stubPlatform('win32');
    try {
      const { computePreview } = await import('./preview.ts');
      computePreview('20260803-000002', { projects: {} });
    } finally {
      stubPlatform(realPlatform);
    }

    expect(existsSync(baselinePath)).toBe(false);
  });

  it('renders the plans the caller supplied instead of recomputing them', async () => {
    // The pull dry-run computes both plans before its rebase moves the repo, so
    // the preview has to render what it was handed rather than re-deriving it
    // from post-rebase state.
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { computePreview } = await import('./preview.ts');
    computePreview('20260803-000004', { projects: {} }, 'pull', {
      captures: [
        {
          kind: 'mirror',
          name: 'CLAUDE.md',
          localPath: '/pre/rebase/CLAUDE.md',
          repoPath: '/pre/shared/CLAUDE.md',
        },
      ],
      deletions: [
        { name: 'commands', localPath: '/pre/rebase/commands/a.md', repoPath: '/pre/shared/a.md' },
      ],
    });

    const joined = logs.join('\n');
    expect(joined).toContain('would capture  /pre/rebase/CLAUDE.md -> /pre/shared/CLAUDE.md');
    expect(joined).toContain(
      'would remove  /pre/shared/a.md (gone from /pre/rebase/commands/a.md)',
    );
  });

  it.skipIf(isWin)('does not throw when a shared path cannot be stat-ed at all', async () => {
    // An antivirus lock or an EPERM makes lstat throw, which
    // `throwIfNoEntry: false` does not suppress. A preview is the surface whose
    // whole value is being safe to run, so it must degrade to missing rows.
    writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local\n');
    writeFileSync(join(repoUnderHome, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
    plantBaseline({ 'CLAUDE.md': { size: 1, mtime: 1, hash: 'x' } });
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const realPlatform = process.platform;
    chmodSync(claudeDir, 0o000);
    stubPlatform('win32');
    try {
      const { computePreview } = await import('./preview.ts');
      expect(() => computePreview('20260803-000005', { projects: {} })).not.toThrow();
    } finally {
      stubPlatform(realPlatform);
      chmodSync(claudeDir, 0o700);
    }
  });

  it.skipIf(isWin)(
    'renders no would-capture or would-remove rows on a non-win32 dry-run (no regression)',
    async () => {
      writeFileSync(join(sharedDir, 'CLAUDE.md'), '# shared-old\n');
      writeFileSync(join(claudeDir, 'CLAUDE.md'), '# local-new\n');
      mkdirSync(join(sharedDir, 'commands'), { recursive: true });
      writeFileSync(join(sharedDir, 'commands', 'gone.md'), '# gone\n');
      mkdirSync(join(claudeDir, 'commands'), { recursive: true });
      plantBaseline({ 'commands/gone.md': { size: 1, mtime: 1, hash: 'x' } });

      expect(process.platform).not.toBe('win32');
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });

      const { computePreview } = await import('./preview.ts');
      computePreview('20260803-000003', { projects: {} });

      const joined = logs.join('\n');
      expect(joined).not.toContain('would capture');
      expect(joined).not.toContain('would remove');
    },
  );
});
