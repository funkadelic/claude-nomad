import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManifestDiff } from './push-manifest.ts';
import type { RemapPullPreviewEvent } from './remap.ts';

describe('remapPull (integration)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('backs up prior destination contents to ~/.cache/.../backup/<ts>/ before cpSync overwrite', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'new-session.jsonl'), '{"new":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    writeFileSync(join(encodedDir, 'old-session.jsonl'), '{"old":true}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const backupOld = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'projects',
      '-tmp-foo',
      'old-session.jsonl',
    );
    expect(existsSync(backupOld)).toBe(true);
    expect(readFileSync(backupOld, 'utf8')).toBe('{"old":true}\n');

    expect(existsSync(join(encodedDir, 'new-session.jsonl'))).toBe(true);
    expect(readFileSync(join(encodedDir, 'new-session.jsonl'), 'utf8')).toBe('{"new":true}\n');
    // Retain-merge: a local-only transcript absent from the repo SURVIVES the
    // pull (it is backed up above as defense-in-depth, not evicted).
    expect(existsSync(join(encodedDir, 'old-session.jsonl'))).toBe(true);
    expect(readFileSync(join(encodedDir, 'old-session.jsonl'), 'utf8')).toBe('{"old":true}\n');
  });

  it('overlays src onto dst additively (local-only files are retained, not deleted)', async () => {
    // Retain-merge (D-01): the pull ADDS c.jsonl and OVERWRITES a.jsonl with the
    // repo content, but the local-only b.jsonl (absent from the repo) survives.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(sharedProjects, 'foo', 'c.jsonl'), '{"c":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    writeFileSync(join(encodedDir, 'a.jsonl'), '{"a":0}\n');
    writeFileSync(join(encodedDir, 'b.jsonl'), '{"b":1}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const finalFiles = readdirSync(encodedDir).sort();
    expect(finalFiles).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl']);
    // a.jsonl overwritten with the repo copy; c.jsonl added; b.jsonl retained.
    expect(readFileSync(join(encodedDir, 'a.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(join(encodedDir, 'b.jsonl'), 'utf8')).toBe('{"b":1}\n');
    expect(readFileSync(join(encodedDir, 'c.jsonl'), 'utf8')).toBe('{"c":1}\n');
  });

  it('retains local-only subagents/ and memory/ entries absent from the repo (incident class)', async () => {
    // The 2026-06-30 incident: a pull-before-push evicted local-only session
    // transcripts, sibling subagents/ dirs, and memory/ files. Retain-merge
    // must keep every local-only entry alive while still overwriting the
    // repo-tracked file and writing the pre-copy backup snapshot.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'shared.jsonl'), '{"repo":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(encodedDir, 'subagents'), { recursive: true });
    mkdirSync(join(encodedDir, 'memory'), { recursive: true });
    writeFileSync(join(encodedDir, 'local-only.jsonl'), '{"local":1}\n');
    writeFileSync(join(encodedDir, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
    writeFileSync(join(encodedDir, 'memory', 'notes.md'), '# notes\n');
    writeFileSync(join(encodedDir, 'shared.jsonl'), '{"old":1}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    // All three local-only entries survive.
    expect(existsSync(join(encodedDir, 'local-only.jsonl'))).toBe(true);
    expect(existsSync(join(encodedDir, 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(existsSync(join(encodedDir, 'memory', 'notes.md'))).toBe(true);
    // The repo-tracked file is overwritten with the repo copy.
    expect(readFileSync(join(encodedDir, 'shared.jsonl'), 'utf8')).toBe('{"repo":1}\n');
    // The pre-copy backup snapshot still exists.
    const backupDir = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'projects',
      '-tmp-foo',
    );
    expect(existsSync(join(backupDir, 'local-only.jsonl'))).toBe(true);
    expect(existsSync(join(backupDir, 'memory', 'notes.md'))).toBe(true);
  });

  it('strips a colliding dst symlink before the overlay (no write-through)', async () => {
    // Poisoned-repo escape: dst holds a benignly-named symlink to an external
    // file; the repo ships a regular file of the same name. The overlay must
    // remove the dst symlink BEFORE cpSync so the external target is untouched
    // and dst holds a fresh regular file with the repo content.
    const external = mkdtempSync(join(tmpdir(), 'nomad-remap-ext-'));
    writeFileSync(join(external, 'target.txt'), 'precious\n');
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'innocent'), 'repo-content\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    symlinkSync(join(external, 'target.txt'), join(encodedDir, 'innocent'));

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    // External target NOT overwritten through the link.
    expect(readFileSync(join(external, 'target.txt'), 'utf8')).toBe('precious\n');
    // dst entry is a fresh regular file with the repo content, not a symlink.
    expect(lstatSync(join(encodedDir, 'innocent')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(encodedDir, 'innocent'), 'utf8')).toBe('repo-content\n');
    rmSync(external, { recursive: true, force: true });
  });

  it('copies 3-level-nested files recursively under <encoded>/', async () => {
    // Regression: 3-level-deep path foo/attachments/sub/deep.bin must
    // survive cpSync recursion.
    const deepSrc = join(sharedProjects, 'foo', 'attachments', 'sub');
    mkdirSync(deepSrc, { recursive: true });
    writeFileSync(join(deepSrc, 'deep.bin'), 'deep-bytes');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    const deepDst = join(claudeProjects, '-tmp-foo', 'attachments', 'sub', 'deep.bin');
    expect(existsSync(deepDst)).toBe(true);
    expect(readFileSync(deepDst, 'utf8')).toBe('deep-bytes');
  });

  it('remapPush backs up prior REPO_HOME destination before clobber', async () => {
    // Local encoded dir has fresh sessions; repo already has older sessions
    // for the same logical. Earlier code blindly copied over the repo copy
    // and the only rollback was git history (which doesn't exist until the
    // later commit step). Current behavior snapshots repo-side state to
    // ~/.cache/claude-nomad/backup/<ts>/repo/ before the clobber.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'older.jsonl'), '{"old":true}\n');
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'newer.jsonl'), '{"new":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    remapPush('20260516-000000');

    // Repo side now has the newer file (clobber happened as before).
    expect(existsSync(join(sharedProjects, 'foo', 'newer.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'older.jsonl'))).toBe(false);
    // And the older file lives in the repo-scoped backup root.
    const backupOlder = join(
      testHome,
      '.cache',
      'claude-nomad',
      'backup',
      '20260516-000000',
      'repo',
      'shared',
      'projects',
      'foo',
      'older.jsonl',
    );
    expect(existsSync(backupOlder)).toBe(true);
    expect(readFileSync(backupOlder, 'utf8')).toBe('{"old":true}\n');
  });

  it('skips entries whose host path is the TBD placeholder (no mutation, no backup)', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'should-not-copy.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': 'TBD' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260516-000000')).not.toThrow();

    expect(existsSync(join(claudeProjects, '-tmp-foo'))).toBe(false);
    expect(existsSync(join(claudeProjects, 'TBD'))).toBe(false);
    expect(readdirSync(claudeProjects)).toEqual([]);

    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('leaves no .nomad-tmp staging dir after a successful pull', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    expect(existsSync(join(claudeProjects, '-tmp-foo'))).toBe(true);
    expect(existsSync(join(claudeProjects, '-tmp-foo.nomad-tmp'))).toBe(false);
  });

  it('overlays into the real dir and leaves a stray sibling staging dir untouched', async () => {
    // The pull side now uses overlaySessionDir (a direct cpSync overlay), not
    // the staging-and-rename atomicMirror, so it neither creates nor removes a
    // `<encoded>.nomad-tmp` sibling. A stray left by a pre-upgrade interrupted
    // pull is left alone (harmless: remapPush's readdir skips `.nomad-tmp`
    // entries, and the sibling never leaks into the overlaid session dir).
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's.jsonl'), '{"new":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // A populated sibling from a prior interrupted copy.
    const stray = join(claudeProjects, '-tmp-foo.nomad-tmp');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'garbage.jsonl'), '{"stale":1}\n');

    const { remapPull } = await import('./remap.ts');
    remapPull('20260516-000000');

    // The real dir got the overlay; the sibling's content did not leak into it.
    expect(readFileSync(join(claudeProjects, '-tmp-foo', 's.jsonl'), 'utf8')).toBe('{"new":1}\n');
    expect(existsSync(join(claudeProjects, '-tmp-foo', 'garbage.jsonl'))).toBe(false);
    // The stray sibling is untouched by the pull overlay.
    expect(existsSync(join(stray, 'garbage.jsonl'))).toBe(true);
  });

  it('remapPush ignores a stray .nomad-tmp staging dir (not pushed, not counted unmapped)', async () => {
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 's.jsonl'), '{"a":1}\n');
    // A stray staging dir left by an interrupted pull sits beside the real dir.
    const stray = join(claudeProjects, '-tmp-foo.nomad-tmp');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'partial.jsonl'), '{"p":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');

    expect(result.unmapped).toBe(0);
    expect(result.pushed).toEqual(['foo']);
    expect(existsSync(join(sharedProjects, 'foo', 's.jsonl'))).toBe(true);
  });

  it('rejects a separator-free ".." host value before it can escape and wipe ~/.claude', async () => {
    // A poisoned path-map host VALUE of ".." must be rejected by the host-value
    // guard BEFORE any path is built: join(projects, "..") would otherwise
    // resolve dst to ~/.claude and copyDir would wipe-and-replace it. The guard
    // is the load-bearing defense here, independent of how encodePath rewrites.
    mkdirSync(join(sharedProjects, 'evil'), { recursive: true });
    writeFileSync(join(sharedProjects, 'evil', 'payload.jsonl'), '{"evil":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { evil: { 'test-host': '..' } } }) + '\n',
    );
    // A sentinel under ~/.claude must still be present after the rejected pull.
    const sentinel = join(testHome, '.claude', 'settings.json');
    writeFileSync(sentinel, '{"keep":true}\n');

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260516-000000')).toThrow(/localRoot/);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('{"keep":true}\n');
  });

  it('rejects a "." host value before it can clobber ~/.claude/projects', async () => {
    mkdirSync(join(sharedProjects, 'evil'), { recursive: true });
    writeFileSync(join(sharedProjects, 'evil', 'payload.jsonl'), '{"evil":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { evil: { 'test-host': '.' } } }) + '\n',
    );
    const survivor = join(claudeProjects, '-tmp-foo', 'mine.jsonl');
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(survivor, '{"mine":1}\n');

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260516-000000')).toThrow(/localRoot/);
    expect(existsSync(survivor)).toBe(true);
  });

  it('rejects a relative (non-absolute) host value', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 's.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': 'relative/path' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260516-000000')).toThrow(/must be absolute/);
  });
});

describe('remapPull dry-run and unmapped count', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does not write to ~/.claude/projects or backup under dryRun and returns unmapped count', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'b.jsonl'), '{"b":1}\n');
    mkdirSync(join(sharedProjects, 'baz'), { recursive: true });
    writeFileSync(join(sharedProjects, 'baz', 'c.jsonl'), '{"c":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': 'TBD' },
          baz: { 'other-host': '/tmp/baz' },
        },
      }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000', { dryRun: true });

    expect(result.unmapped).toBe(2);
    // foo is mapped for this host, so it would be pulled; bar (TBD) and baz
    // (other-host) are unmapped and do not appear in wouldPull. The wet-mode
    // pulled array stays empty under dryRun.
    expect(result.wouldPull).toEqual(['foo']);
    expect(result.pulled).toEqual([]);
    expect(existsSync(join(claudeProjects, '-tmp-foo'))).toBe(false);
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('default (no opts) returns the same unmapped count AND performs the copy for non-skipped entries', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'b.jsonl'), '{"b":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': 'TBD' },
        },
      }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');

    expect(result.unmapped).toBe(1);
    // Wet mode records the copied logical in `pulled`; `wouldPull` stays empty.
    expect(result.pulled).toEqual(['foo']);
    expect(result.wouldPull).toEqual([]);
    expect(existsSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'))).toBe(true);
  });

  it('early-return path (no path-map.json) returns unmapped:0 and empty detail arrays', async () => {
    // No path-map.json written.
    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');
    expect(result.unmapped).toBe(0);
    expect(result.pulled).toEqual([]);
    expect(result.wouldPull).toEqual([]);
  });
});

describe('remapPull onPreview structured sink', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-onpreview-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('calls onPreview with an overwrite event and does NOT call log() for would-overwrite', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const events: RemapPullPreviewEvent[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { remapPull } = await import('./remap.ts');
    remapPull('ts1', {
      dryRun: true,
      onPreview: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe('overwrite');
    if (ev.kind !== 'overwrite') throw new Error('expected overwrite event');
    expect(ev.dst).toContain('-tmp-foo');
    expect(ev.src).toContain('foo');
    const logLines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).not.toContain('would overwrite:');
  });

  it('emits a note event (not a log line) when there is nothing to remap', async () => {
    // No path-map.json present -> remapPull takes the degenerate early return.
    const events: RemapPullPreviewEvent[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    const { remapPull } = await import('./remap.ts');
    remapPull('ts3', { dryRun: true, onPreview: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe('note');
    if (ev.kind !== 'note') throw new Error('expected note event');
    expect(ev.text).toContain('skipping session remap');
    const logLines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).not.toContain('skipping session remap');
  });

  it('falls back to log() for the nothing-to-remap note when onPreview is absent', async () => {
    // No path-map.json: early return logs the note with no onPreview sink.
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { remapPull } = await import('./remap.ts');
    remapPull('ts4', { dryRun: true });
    expect(logs.join('\n')).toContain('no path-map or repo projects dir; skipping session remap');
  });

  it('falls back to log() for would-overwrite when onPreview is absent', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const { remapPull } = await import('./remap.ts');
    remapPull('ts2', { dryRun: true });
    expect(logs.join('\n')).toContain('would overwrite:');
  });
});

describe('remapPush dry-run and unmapped count', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-test-home-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does not copy anything under dryRun and returns unmapped + collisions:0', async () => {
    // -tmp-foo is mapped; -tmp-drive-by is not mapped (counts as unmapped).
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(claudeProjects, '-tmp-drive-by'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-drive-by', 'd.jsonl'), '{"d":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000', { dryRun: true });

    expect(result.unmapped).toBe(1);
    expect(result.collisions).toBe(0);
    // foo is mapped, so it would be pushed; -tmp-drive-by is unmapped and
    // does not appear. Wet `pushed` stays empty under dryRun.
    expect(result.wouldPush).toEqual(['foo']);
    expect(result.pushed).toEqual([]);
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(false);
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('default (no opts) returns same shape and still performs the copy', async () => {
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'), '{"a":1}\n');
    mkdirSync(join(claudeProjects, '-tmp-drive-by'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-drive-by', 'd.jsonl'), '{"d":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');

    expect(result.unmapped).toBe(1);
    expect(result.collisions).toBe(0);
    // Wet mode records the copied logical in `pushed`; `wouldPush` stays empty.
    expect(result.pushed).toEqual(['foo']);
    expect(result.wouldPush).toEqual([]);
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(true);
  });

  it('early-return path (no path-map.json) returns unmapped:0, collisions:0, empty detail arrays', async () => {
    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');
    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
    expect(result.pushed).toEqual([]);
    expect(result.wouldPush).toEqual([]);
  });

  it('early-return path (path-map present, no local projects dir) returns 0/0 and creates nothing', async () => {
    // path-map.json exists so remapPush passes the first early return and
    // builds the reverse map, but `~/.claude/projects/` is absent, so the
    // `!existsSync(localProjects)` guard returns before any directory walk.
    // The guard runs before the repoProjects mkdir, so the no-op push leaves
    // no empty shared/projects/ behind.
    rmSync(claudeProjects, { recursive: true, force: true });
    rmSync(join(repoUnderHome, 'shared'), { recursive: true, force: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');
    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
    expect(existsSync(sharedProjects)).toBe(false);
  });

  it('reverse map filters TBD and empty-string host values (push line 103)', async () => {
    // The reverse map in remapPush walks path-map.json's per-host entries
    // and skips any that are empty-string or `'TBD'`. Without the skip, an
    // unmapped host's `TBD` would be encoded to the literal string `'TBD'`
    // and could match a local encoded dir. The test plants a mapped entry
    // plus a TBD entry plus an empty-string entry; only the mapped one
    // participates in the copy, the TBD/empty are filtered out of the
    // reverse map AND therefore neither contribute to the unmapped count
    // (their local encoded dir does not exist) nor to the copy.
    mkdirSync(join(claudeProjects, '-srv-mapped'), { recursive: true });
    writeFileSync(join(claudeProjects, '-srv-mapped', 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          mapped: { 'test-host': '/srv/mapped' },
          placeholder: { 'test-host': 'TBD' },
          blank: { 'test-host': '' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260516-000000');

    expect(result.unmapped).toBe(0);
    expect(result.collisions).toBe(0);
    expect(existsSync(join(sharedProjects, 'mapped', 'session.jsonl'))).toBe(true);
    // TBD/blank logicals must not appear in shared/projects/ because they
    // were filtered from the reverse map and never matched any local dir.
    expect(existsSync(join(sharedProjects, 'placeholder'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'blank'))).toBe(false);
  });
});

describe('remapPush collision detection', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-collision-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('throws NomadFatal when two distinct paths encode to the same key', async () => {
    // /tmp/foo/bar and /tmp/foo-bar both encode to -tmp-foo-bar.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);
  });

  it('collision message contains both abspaths, the encoded key, nomad doctor, and path-map.json', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('/tmp/foo/bar');
    expect(msg).toContain('/tmp/foo-bar');
    expect(msg).toContain('-tmp-foo-bar');
    expect(msg).toContain('nomad doctor');
    expect(msg).toContain('path-map.json');
  });

  it('does not write to shared/projects/ when collision is detected', async () => {
    const encodedLocal = join(claudeProjects, '-tmp-foo-bar');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);

    // No content written to shared/projects/
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
    // No backup dir created either
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260516-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it('does not create the repo shared/projects/ dir when collision is detected', async () => {
    // Remove the pre-created repo destination so we can prove a dying push is
    // fully side-effect-free: collision detection runs before the repoProjects
    // mkdir, so no empty shared/projects/ is left behind.
    rmSync(join(repoUnderHome, 'shared'), { recursive: true, force: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000')).toThrow(NomadFatal);
    expect(existsSync(sharedProjects)).toBe(false);
    expect(existsSync(join(repoUnderHome, 'shared'))).toBe(false);
  });

  it('throws NomadFatal under dryRun:true when collision is detected', async () => {
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000', { dryRun: true })).toThrow(NomadFatal);
  });

  it('throws under dryRun:true even when a local dir matches the colliding key', async () => {
    // The exact data-loss scenario: a local encoded dir matching the colliding
    // key exists and a dry-run preview is requested. Detection fails closed
    // before the dryRun branch, so the local transcript is left intact and
    // nothing is staged, even in preview mode.
    const encodedLocal = join(claudeProjects, '-tmp-foo-bar');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260516-000000', { dryRun: true })).toThrow(NomadFatal);
    expect(existsSync(join(encodedLocal, 'session.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
  });

  it('reports only the first colliding pair when 3+ paths share an encoded key', async () => {
    // /tmp/foo/bar, /tmp/foo-bar, and /tmp-foo/bar all encode to -tmp-foo-bar.
    // Detection dies on the first colliding pair it meets in insertion order,
    // so the message names alpha and beta and never reaches the third path.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo/bar' },
          beta: { 'test-host': '/tmp/foo-bar' },
          gamma: { 'test-host': '/tmp-foo/bar' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('/tmp/foo/bar');
    expect(msg).toContain('/tmp/foo-bar');
    expect(msg).not.toContain('/tmp-foo/bar');
  });

  it('throws when two logical names map to the same absolute path (would orphan one)', async () => {
    // Two logicals, one host path: only one logical could be pushed and the
    // other's shared/projects/ copy would be silently orphaned, so the push
    // fails closed instead of dropping a logical via last-write-wins.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          alpha: { 'test-host': '/tmp/foo' },
          beta: { 'test-host': '/tmp/foo' },
        },
      }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPush('20260516-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    const msg = caught?.message ?? '';
    expect(msg).toContain('duplicate path in path-map.json');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
    expect(msg).toContain('/tmp/foo');
    // Neither logical was pushed; nothing orphaned.
    expect(existsSync(join(sharedProjects, 'alpha'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'beta'))).toBe(false);
  });
});

// remapPush copies only top-level *.jsonl files at depth 0; non-jsonl
// files at depth 0 are skipped with a log line; subdirectory contents
// traverse unfiltered; the cpSync source-root case is allowed explicitly;
// remapPull stays unfiltered (no regression).
describe('remapPush source-side filter', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-srcfilter-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('copies top-level *.jsonl files through remapPush', async () => {
    // Baseline contract: the happy path keeps working. A session JSONL at
    // depth 0 must reach the staged tree byte-for-byte.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"role":"user"}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    const dst = join(sharedProjects, 'foo', 'sid-A.jsonl');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"role":"user"}\n');
  });

  it('skips top-level non-jsonl files (.bak, .tmp) with one log line each', async () => {
    // Stray local clutter (.bak from a manual scrub, .tmp from editor
    // crash) must never enter the staged tree. Each skip emits one
    // `ℹ︎ skip <rel>: extension not in allowlist` log line.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"role":"user"}\n');
    writeFileSync(join(encodedLocal, 'sid-A.bak'), 'leaked-secret\n');
    writeFileSync(join(encodedLocal, 'tmp.txt'), 'crash-artifact\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    // The jsonl copies through; the .bak and tmp.txt do not.
    expect(existsSync(join(sharedProjects, 'foo', 'sid-A.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'sid-A.bak'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'foo', 'tmp.txt'))).toBe(false);

    const skipLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('skip') && line.includes('extension not in allowlist'));
    expect(skipLines).toHaveLength(2);
    expect(skipLines.some((l) => l.includes('sid-A.bak'))).toBe(true);
    expect(skipLines.some((l) => l.includes('tmp.txt'))).toBe(true);
  });

  it('copies subdirectory contents recursively with no filter at depth >=1', async () => {
    // Sub-trees (subagents/, memory/, tool-results/, future names) keep
    // their existing recursive copyDir behavior. A subagent meta-json or a
    // memory markdown file must flow through; the depth-0 filter must NOT
    // fire on depth >=1 entries.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(encodedLocal, 'subagents'), { recursive: true });
    mkdirSync(join(encodedLocal, 'memory'), { recursive: true });
    writeFileSync(join(encodedLocal, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
    writeFileSync(join(encodedLocal, 'subagents', 'agent-1.meta.json'), '{"meta":true}\n');
    writeFileSync(join(encodedLocal, 'memory', 'notes.md'), '# notes\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    expect(existsSync(join(sharedProjects, 'foo', 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'subagents', 'agent-1.meta.json'))).toBe(true);
    expect(existsSync(join(sharedProjects, 'foo', 'memory', 'notes.md'))).toBe(true);

    // No skip log lines for depth >=1 entries.
    const skipLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('extension not in allowlist'));
    expect(skipLines).toHaveLength(0);
  });

  it('does not log a spurious skip line for the cpSync source-root case', async () => {
    // Pitfall 1: cpSync invokes the filter on srcPath === src first.
    // The callback must return true unconditionally for that case (relative
    // path is the empty string). A naive implementation that splits the
    // empty rel into [''] and applies the depth-0 jsonl-only check would
    // log a bogus `ℹ︎ skip : extension not in allowlist` line and
    // abort the entire copy.
    const encodedLocal = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedLocal, { recursive: true });
    writeFileSync(join(encodedLocal, 'sid-A.jsonl'), '{"ok":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });

    const { remapPush } = await import('./remap.ts');
    remapPush('20260520-000000');

    // No skip log line with an empty <rel> field. Match the structural
    // shape "skip : " (skip + space + colon + space) that a buggy
    // empty-rel callback would emit.
    const badSkip = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('ℹ︎ skip : extension not in allowlist'));
    expect(badSkip).toHaveLength(0);

    // Dst dir exists and is non-empty (the copy completed).
    expect(existsSync(join(sharedProjects, 'foo'))).toBe(true);
    expect(readdirSync(join(sharedProjects, 'foo')).length).toBeGreaterThan(0);
  });

  it('remapPull stays unfiltered: non-jsonl files in shared/projects/<logical>/ copy to local', async () => {
    // Regression guard: only remapPush gains the source-side filter.
    // remapPull keeps the unfiltered copyDir because the repo side is
    // already curated by the push gate. A future PR that applies
    // copyDirJsonlOnly symmetrically would break this test.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'sid-A.txt'), 'curated\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    remapPull('20260520-000000');

    const dst = join(claudeProjects, '-tmp-foo', 'sid-A.txt');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('curated\n');
  });
});

describe('remapPull / remapPush poisoned logical key (path-traversal guard)', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-traversal-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('remapPull throws NomadFatal for a traversal key and writes nothing outside shared/projects/', async () => {
    // The traversal guard fires at the top of the loop, before existsSync(src)
    // or any join/copy, so no source dir is planted: planting at the traversal
    // key would itself write outside the test sandbox.
    const poisonedKey = '../../../../tmp/escape';
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { [poisonedKey]: { 'test-host': '/tmp/escape' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPull('20260530-000000')).toThrow(NomadFatal);

    // No encoded dir written under ~/.claude/projects/
    expect(existsSync(join(claudeProjects, '-tmp-escape'))).toBe(false);
    expect(readdirSync(claudeProjects)).toEqual([]);
  });

  it('remapPull NomadFatal message names the invalid logical key', async () => {
    const poisonedKey = '../../../../tmp/escape';
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { [poisonedKey]: { 'test-host': '/tmp/escape' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    let caught: Error | undefined;
    try {
      remapPull('20260530-000000');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(NomadFatal);
    expect(caught?.message).toContain(poisonedKey);
  });

  it('remapPush throws NomadFatal for a traversal key via buildReverseMap', async () => {
    // buildReverseMap iterates map.projects keys; the guard must fire before
    // any logical is used to build the reverse lookup or reach shared/projects/.
    const poisonedKey = '../../../../tmp/escape';
    mkdirSync(join(claudeProjects, '-tmp-escape'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-escape', 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { [poisonedKey]: { 'test-host': '/tmp/escape' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => remapPush('20260530-000000')).toThrow(NomadFatal);

    // No write made to shared/projects/
    expect(readdirSync(sharedProjects)).toEqual([]);
  });

  it('normal logical "foo" still pulls without error (no regression)', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPull } = await import('./remap.ts');
    expect(() => remapPull('20260530-000000')).not.toThrow();
    expect(existsSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'))).toBe(true);
  });

  it('normal logical "foo" still pushes without error (no regression)', async () => {
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { remapPush } = await import('./remap.ts');
    expect(() => remapPush('20260530-000000')).not.toThrow();
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(true);
  });
});

// Covers remap.ts line 56: `if (!existsSync(src)) continue` in remapPull.
// Lives outside the prior describe blocks because it needs a sandbox where
// the path-map is mapped for this host but the repo's
// shared/projects/<logical>/ source is intentionally missing. Easy to model
// with a fresh fixture.
describe('remapPull skips when repo source is missing for a mapped logical', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-no-src-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    // shared/projects/ exists but the per-logical dir does NOT.
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns unmapped:0 and does not create the encoded local dir when shared/projects/<logical>/ is absent', async () => {
    // path-map maps `ghost` to `/srv/ghost` for this host, BUT there is no
    // shared/projects/ghost/ dir in the repo. The `if (!existsSync(src))
    // continue` branch fires (line 56), no copy happens, the encoded local
    // dir is never created. unmapped stays 0 because the host has a mapping.
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: { ghost: { 'test-host': '/srv/ghost' } },
      }) + '\n',
    );
    expect(existsSync(join(sharedProjects, 'ghost'))).toBe(false);

    const { remapPull } = await import('./remap.ts');
    const result = remapPull('20260516-000000');

    expect(result.unmapped).toBe(0);
    expect(existsSync(join(claudeProjects, '-srv-ghost'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remapPush selective copy: per-file atomic copy driven by ManifestDiff.
// ---------------------------------------------------------------------------

describe('remapPush selective', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-selective-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('preserves inode and mtime of an unchanged file not in selection.changed', async () => {
    // Unchanged files must not be opened or written during a selective push,
    // so their destination inode and mtime stay identical after the call.
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'unchanged.jsonl'), '{"unchanged":true}\n');
    writeFileSync(join(localDir, 'changed.jsonl'), '{"v":2}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // Pre-populate the repo side with the unchanged file.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'unchanged.jsonl'), '{"unchanged":true}\n');

    const beforeStat = statSync(join(sharedProjects, 'foo', 'unchanged.jsonl'));

    const selection: ManifestDiff = {
      changed: new Set([join(localDir, 'changed.jsonl')]),
      deleted: [],
    };

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000', { selection });

    expect(result.pushed).toEqual(['foo']);

    // Unchanged file: inode and mtime must be bit-for-bit identical.
    const afterStat = statSync(join(sharedProjects, 'foo', 'unchanged.jsonl'));
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    // Changed file: must now exist in the repo with the new content.
    expect(existsSync(join(sharedProjects, 'foo', 'changed.jsonl'))).toBe(true);
    expect(readFileSync(join(sharedProjects, 'foo', 'changed.jsonl'), 'utf8')).toBe('{"v":2}\n');
  });

  it('atomically replaces a changed file and leaves no .tmp sibling', async () => {
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'session.jsonl'), '{"role":"assistant"}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // Repo side has the old content.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'session.jsonl'), '{"role":"user"}\n');

    const srcPath = join(localDir, 'session.jsonl');
    const selection: ManifestDiff = { changed: new Set([srcPath]), deleted: [] };

    const { remapPush } = await import('./remap.ts');
    remapPush('20260630-000000', { selection });

    expect(readFileSync(join(sharedProjects, 'foo', 'session.jsonl'), 'utf8')).toBe(
      '{"role":"assistant"}\n',
    );
    // No .tmp sibling should remain after the rename swap.
    const fooFiles = readdirSync(join(sharedProjects, 'foo'));
    expect(fooFiles.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('removes a deleted-source file from the repo tree', async () => {
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    // Only 'remaining.jsonl' exists in source now; 'gone.jsonl' was deleted.
    writeFileSync(join(localDir, 'remaining.jsonl'), '{"keep":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // Repo side still has the old file.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'gone.jsonl'), '{"old":true}\n');
    writeFileSync(join(sharedProjects, 'foo', 'remaining.jsonl'), '{"keep":true}\n');

    // The source path that was recorded in the old manifest but is now gone.
    const deletedSrc = join(localDir, 'gone.jsonl');
    const selection: ManifestDiff = { changed: new Set(), deleted: [deletedSrc] };

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000', { selection });

    expect(result.pushed).toEqual(['foo']);
    expect(existsSync(join(sharedProjects, 'foo', 'gone.jsonl'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'foo', 'remaining.jsonl'))).toBe(true);
  });

  it('copies a changed nested file under a subdirectory (memory/notes.md)', async () => {
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(localDir, 'memory'), { recursive: true });
    writeFileSync(join(localDir, 'memory', 'notes.md'), '# updated notes\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    mkdirSync(join(sharedProjects, 'foo', 'memory'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'memory', 'notes.md'), '# old notes\n');

    const srcPath = join(localDir, 'memory', 'notes.md');
    const selection: ManifestDiff = { changed: new Set([srcPath]), deleted: [] };

    const { remapPush } = await import('./remap.ts');
    remapPush('20260630-000000', { selection });

    expect(readFileSync(join(sharedProjects, 'foo', 'memory', 'notes.md'), 'utf8')).toBe(
      '# updated notes\n',
    );
  });

  it('cold-start (no selection) copies the full set and removes stale files', async () => {
    // Regression guard: without a selection, remapPush falls back to
    // copyDirJsonlOnly (atomicMirror), which produces the same result as before.
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'newer.jsonl'), '{"new":true}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // Repo side has a stale file.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'older.jsonl'), '{"old":true}\n');

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000');

    expect(result.pushed).toEqual(['foo']);
    expect(existsSync(join(sharedProjects, 'foo', 'newer.jsonl'))).toBe(true);
    // atomicMirror wipes the dest dir, so the stale file is gone.
    expect(existsSync(join(sharedProjects, 'foo', 'older.jsonl'))).toBe(false);
  });

  it('skips logicals with no delta files (nothing to push, no backup created)', async () => {
    // A logical present in the reverse map but with no files in the selection
    // must be skipped entirely: no backup, not in pushed.
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'session.jsonl'), '{"x":1}\n');

    // Selection with paths for a DIFFERENT project (none under localDir).
    const otherPath = join(claudeProjects, '-tmp-other', 'session.jsonl');
    const selection: ManifestDiff = { changed: new Set([otherPath]), deleted: [] };

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000', { selection });

    // Nothing was pushed for foo (it had no delta).
    expect(result.pushed).toEqual([]);
    // No backup directory created (backupRepoWrite not called).
    const backupRoot = join(testHome, '.cache', 'claude-nomad', 'backup', '20260630-000000');
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("multi-project selection: files for other projects skipped during each dir's copy", async () => {
    // When the selection spans two projects, applySelective must only copy
    // files whose prefix matches the current localDir, skipping the other
    // project's files. This covers the `continue` branches inside applySelective.
    const localDirFoo = join(claudeProjects, '-tmp-foo');
    const localDirBar = join(claudeProjects, '-tmp-bar');
    mkdirSync(localDirFoo, { recursive: true });
    mkdirSync(localDirBar, { recursive: true });
    writeFileSync(join(localDirFoo, 'foo.jsonl'), '{"foo":1}\n');
    writeFileSync(join(localDirBar, 'bar.jsonl'), '{"bar":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': '/tmp/bar' },
        },
      }) + '\n',
    );
    // Repo side: bar has a stale file that should be removed (via deleted).
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    mkdirSync(join(sharedProjects, 'bar'), { recursive: true });
    writeFileSync(join(sharedProjects, 'bar', 'old.jsonl'), '{"old":1}\n');

    // Selection spans both: foo has a changed file; bar has a deleted file.
    const selection: ManifestDiff = {
      changed: new Set([join(localDirFoo, 'foo.jsonl')]),
      deleted: [join(localDirBar, 'old.jsonl')],
    };

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000', { selection });

    expect(result.pushed.sort()).toEqual(['bar', 'foo']);
    // foo's changed file copied; bar's changed file (from selection) was for bar, not foo.
    expect(readFileSync(join(sharedProjects, 'foo', 'foo.jsonl'), 'utf8')).toBe('{"foo":1}\n');
    // bar's deleted file removed.
    expect(existsSync(join(sharedProjects, 'bar', 'old.jsonl'))).toBe(false);
    // bar.jsonl not in foo's shared dir.
    expect(existsSync(join(sharedProjects, 'foo', 'bar.jsonl'))).toBe(false);
  });

  it('ignores a deleted path whose repo-side copy is already absent', async () => {
    // If a source file is in selection.deleted but the repo-side copy does not
    // exist (already removed or never synced), rmSync must be skipped gracefully.
    const localDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'session.jsonl'), '{"x":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    // Repo side does NOT have 'ghost.jsonl'.
    const ghostSrc = join(localDir, 'ghost.jsonl');
    const selection: ManifestDiff = { changed: new Set(), deleted: [ghostSrc] };

    const { remapPush } = await import('./remap.ts');
    // Must not throw even though the repo-side copy is absent.
    const result = remapPush('20260630-000000', { selection });
    // foo had delta (the deleted ghost path), so it is recorded as pushed.
    expect(result.pushed).toEqual(['foo']);
    // The repo side was already clean: no error and no stray files created.
    expect(readdirSync(join(sharedProjects, 'foo'))).toHaveLength(0);
  });

  it('selective dryRun includes logicals with delta in wouldPush, excludes unchanged', async () => {
    const localDirFoo = join(claudeProjects, '-tmp-foo');
    const localDirBar = join(claudeProjects, '-tmp-bar');
    mkdirSync(localDirFoo, { recursive: true });
    mkdirSync(localDirBar, { recursive: true });
    writeFileSync(join(localDirFoo, 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(localDirBar, 'b.jsonl'), '{"b":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': '/tmp/foo' },
          bar: { 'test-host': '/tmp/bar' },
        },
      }) + '\n',
    );

    // Only foo has a changed file; bar has no delta.
    const selection: ManifestDiff = {
      changed: new Set([join(localDirFoo, 'a.jsonl')]),
      deleted: [],
    };

    const { remapPush } = await import('./remap.ts');
    const result = remapPush('20260630-000000', { dryRun: true, selection });

    expect(result.wouldPush).toEqual(['foo']);
    expect(result.pushed).toEqual([]);
    // No files written.
    expect(existsSync(join(sharedProjects, 'foo', 'a.jsonl'))).toBe(false);
    expect(existsSync(join(sharedProjects, 'bar', 'b.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanLocalOnly: read-only count of local-only leaf files across mapped
// projects (D-06 honest-count input for the wet pull summary and preview).
// ---------------------------------------------------------------------------

describe('scanLocalOnly', () => {
  let originalHome: string | undefined;
  let originalNomadHost: string | undefined;
  let testHome: string;
  let repoUnderHome: string;
  let sharedProjects: string;
  let claudeProjects: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadHost = process.env.NOMAD_HOST;
    testHome = mkdtempSync(join(tmpdir(), 'nomad-remap-scan-'));
    process.env.HOME = testHome;
    process.env.NOMAD_HOST = 'test-host';
    repoUnderHome = join(testHome, 'claude-nomad');
    sharedProjects = join(repoUnderHome, 'shared', 'projects');
    claudeProjects = join(testHome, '.claude', 'projects');
    mkdirSync(sharedProjects, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('counts 3 local-only leaf files (top-level, subagents/, memory/) absent from the repo', async () => {
    // Repo has only shared.jsonl; the local encoded dir adds a top-level
    // transcript plus a wholly local-only subagents/ file and memory/ file.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'shared.jsonl'), '{"repo":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(encodedDir, 'subagents'), { recursive: true });
    mkdirSync(join(encodedDir, 'memory'), { recursive: true });
    writeFileSync(join(encodedDir, 'shared.jsonl'), '{"repo":1}\n');
    writeFileSync(join(encodedDir, 'local.jsonl'), '{"local":1}\n');
    writeFileSync(join(encodedDir, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
    writeFileSync(join(encodedDir, 'memory', 'notes.md'), '# notes\n');

    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(3);
  });

  it('returns 0 when the local dir exactly mirrors the repo (including a subdir)', async () => {
    mkdirSync(join(sharedProjects, 'foo', 'sub'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(sharedProjects, 'foo', 'sub', 'b.jsonl'), '{"b":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(join(encodedDir, 'sub'), { recursive: true });
    writeFileSync(join(encodedDir, 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(encodedDir, 'sub', 'b.jsonl'), '{"b":1}\n');

    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(0);
  });

  it('contributes 0 for TBD and empty-string host mappings', async () => {
    // Both a 'TBD' and an empty-string host value are skipped like remapPull.
    // Even though a local encoded dir exists, an unmapped host contributes 0.
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({
        projects: {
          foo: { 'test-host': 'TBD' },
          bar: { 'test-host': '' },
        },
      }) + '\n',
    );
    mkdirSync(join(claudeProjects, '-tmp-foo'), { recursive: true });
    writeFileSync(join(claudeProjects, '-tmp-foo', 'orphan.jsonl'), '{"x":1}\n');

    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(0);
  });

  it('skips a mapped project whose local encoded dir does not exist', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'a.jsonl'), '{"a":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    // No ~/.claude/projects/-tmp-foo dir created.

    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(0);
  });

  it('returns 0 when path-map.json is absent', async () => {
    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(0);
  });

  it('returns 0 when the repo projects dir is absent', async () => {
    rmSync(sharedProjects, { recursive: true, force: true });
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );

    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(0);
  });

  it('performs no filesystem mutation (trees byte-identical before and after)', async () => {
    mkdirSync(join(sharedProjects, 'foo'), { recursive: true });
    writeFileSync(join(sharedProjects, 'foo', 'shared.jsonl'), '{"repo":1}\n');
    writeFileSync(
      join(repoUnderHome, 'path-map.json'),
      JSON.stringify({ projects: { foo: { 'test-host': '/tmp/foo' } } }) + '\n',
    );
    const encodedDir = join(claudeProjects, '-tmp-foo');
    mkdirSync(encodedDir, { recursive: true });
    writeFileSync(join(encodedDir, 'shared.jsonl'), '{"repo":1}\n');
    writeFileSync(join(encodedDir, 'local.jsonl'), '{"local":1}\n');

    const before = readdirSync(encodedDir).sort();
    const { scanLocalOnly } = await import('./remap.ts');
    expect(scanLocalOnly()).toBe(1);
    const after = readdirSync(encodedDir).sort();

    expect(after).toEqual(before);
    // The local-only file is untouched (not deleted, content intact).
    expect(readFileSync(join(encodedDir, 'local.jsonl'), 'utf8')).toBe('{"local":1}\n');
  });
});
