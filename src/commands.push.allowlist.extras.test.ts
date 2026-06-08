import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PathMap } from './config.ts';

// Extras allow-list widening: `enforceAllowList` builds its runtime allowed
// array by spreading `Object.keys(map.extras ?? {})` into one prefix per
// declared logical, mirroring the existing `shared/projects/<logical>/`
// pattern. A staged path under a declared logical passes; one under an
// unmapped logical (no `extras` entry for that name) fails with the existing
// `to sync ... add to PUSH_ALLOWED` FATAL. Data-driven by construction so
// Pitfall 4 (allow-list bypass via crafted `shared/extras/` path) is closed.
describe('enforceAllowList: extras prefix', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('permits shared/extras/<logical>/ paths when logical is declared in extras map', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    // A staged file under the declared logical must pass without throwing.
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/PLAN.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects shared/extras/<logical>/ paths when logical is not in extras map', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // `bar` is not in extras, so the runtime allowed array has no entry for
    // it. The classifier surfaces the existing `to sync ...` FATAL.
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() => enforceAllowList('A  shared/extras/bar/.planning/PLAN.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync shared/extras/bar/.planning/PLAN.md'),
    );
  });

  it('legacy path-map.json without extras key produces no extras allow-list entries', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Absence of the `extras` key (D-03 additive contract) means no
    // `shared/extras/` prefixes are generated; any such path is rejected.
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/PLAN.md\0', map)).toThrow(
      NomadFatal,
    );
  });

  it('rejects non-whitelisted dirnames under a declared extras logical', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Declaring `foo: ['.planning']` only widens the allow-list for the
    // whitelisted dirname; manually staged content under `random-dir` (or any
    // name outside `SUPPORTED_EXTRAS`) must still surface as FATAL so the
    // dirname whitelist is enforced at the staging boundary, not just inside
    // `remapExtrasPush`.
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/random-dir/FILE.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync shared/extras/foo/random-dir/FILE.md'),
    );
  });

  it('drops non-whitelisted dirnames from the allow-list even when declared in path-map.json', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // If `path-map.json` declares a dirname outside `SUPPORTED_EXTRAS`,
    // `remapExtrasPush` skips it with a log line, so it never reaches the
    // staged tree on a clean run. The allow-list filters by the same
    // whitelist so a manually staged copy is still blocked.
    const map: PathMap = { projects: {}, extras: { foo: ['.scratch'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/.scratch/note.md\0', map)).toThrow(
      NomadFatal,
    );
  });

  it('permits a single root-file extra staged at shared/extras/<logical>/CLAUDE.md', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    // A whitelisted file produces a staged path with no trailing slash and no
    // children. The exact allow-list entry (added alongside the prefix entry)
    // must match it so the file push is not rejected.
    const map: PathMap = { projects: {}, extras: { foo: ['CLAUDE.md'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/CLAUDE.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still rejects an arbitrary sibling file under the same logical when a file extra is declared', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Declaring `foo: ['CLAUDE.md']` adds an exact entry for CLAUDE.md and a
    // prefix entry for the CLAUDE.md/ subtree, NOT a logical-only
    // `shared/extras/foo/` prefix. An unrelated sibling file must still FATAL,
    // proving the exact+prefix pair did not widen the boundary.
    const map: PathMap = { projects: {}, extras: { foo: ['CLAUDE.md'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/secrets.txt\0', map)).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('to sync shared/extras/foo/secrets.txt'),
    );
  });

  it('leaves directory extras unchanged: a subtree path under a declared dir still passes', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    // Regression guard for the prefix entry: a directory extra still permits
    // its subtree after the exact+prefix change. The exact entry alone would
    // not match a child path, so this proves the prefix entry survives.
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/PLAN.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// isNeverSync scope fix: paths under `shared/extras/` are exempt from the
// `NEVER_SYNC` segment scan because the segment list was authored against
// `~/.claude/` semantics for ephemeral Claude Code state. `.planning/todos/`
// inside the extras tree is a meaningful GSD path; blocking it would corrupt
// the sync. The early-return narrows scope to non-extras paths only; the
// regression guard below proves the original surface still blocks.
describe('isNeverSync: extras scope', () => {
  it('returns false for shared/extras/<logical>/.planning/todos/... paths (Pitfall 6 fix)', async () => {
    // Re-import via a small wrapper because isNeverSync is not exported.
    // The acceptance signal is end-to-end via enforceAllowList: a path that
    // would otherwise hit the `todos` segment hard-block must pass when it
    // lives under `shared/extras/`.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/todos/2026-05-22-task.md\0', map),
    ).not.toThrow();
  });

  it('returns false for shared/extras/<logical>/.planning/plans/... paths (Pitfall 6 regression)', async () => {
    // `plans` is in NEVER_SYNC but is legitimate GSD content inside .planning/;
    // it must remain allowed under shared/extras/ after narrowing the exemption.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/plans/x.md\0', map),
    ).not.toThrow();
  });

  it('still hard-blocks NEVER_SYNC segments outside shared/extras/ (regression guard)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // A path NOT prefixed with `shared/extras/` that contains a NEVER_SYNC
    // segment must still trigger the hard-block. This proves the early-return
    // narrows scope rather than removing the guard wholesale.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/projects/foo/todos/file.md\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('shared/projects/foo/todos/file.md is in NEVER_SYNC'),
    );
    vi.restoreAllMocks();
  });
});

// ALWAYS_NEVER_SYNC enforcement: genuinely-sensitive host-local files must be
// hard-blocked even when nested under shared/extras/, where the broader NEVER_SYNC
// exemption would otherwise let them through. The narrowed exemption keeps
// ephemeral dir-name segments (todos, plans, etc.) allowed under extras while
// refusing to pass credential and host-config files.
describe('isNeverSync: ALWAYS_NEVER_SYNC enforced under extras', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Shared fixture: a map with .planning declared for logical `foo`. */
  const map: PathMap = { projects: {}, extras: { foo: ['.planning'] } };

  it('hard-blocks .credentials.json nested under shared/extras/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/.credentials.json\0', map),
    ).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks settings.local.json nested under shared/extras/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/settings.local.json\0', map),
    ).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks .claude.json nested under shared/extras/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/.claude.json\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks history.jsonl nested under shared/extras/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => enforceAllowList('A  shared/extras/foo/.planning/history.jsonl\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks stats-cache.json nested under shared/extras/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/stats-cache.json\0', map),
    ).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });
});

// The `.claude` extra mirrors `~/.claude/` semantics, so its subtree uses the
// FULL NEVER_SYNC boundary at the push gate (not the narrow ALWAYS_NEVER_SYNC
// subset that `.planning` gets). This backstops the copy-side filter: ephemeral
// host-local names (sessions, shell-snapshots, todos, projects) staged under a
// `.claude` extra are hard-blocked, while the same names under `.planning` pass.
describe('isNeverSync: .claude extra uses full NEVER_SYNC boundary', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const map: PathMap = { projects: {}, extras: { foo: ['.claude', '.planning'] } };

  it('hard-blocks shell-snapshots/ under a .claude extra (NEVER_SYNC-only segment)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.claude/shell-snapshots/snap.sh\0', map),
    ).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks sessions/ under a .claude extra (NEVER_SYNC-only segment)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    expect(() => enforceAllowList('A  shared/extras/foo/.claude/sessions/s.json\0', map)).toThrow(
      NomadFatal,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('hard-blocks projects/ under a .claude extra (transcripts; CLAUDE_EXTRA_NEVER_SYNC adds it)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // `projects` is NOT in base NEVER_SYNC (it is the path-remap destination),
    // so this proves the .claude denylist is the CLAUDE_EXTRA_NEVER_SYNC superset.
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.claude/projects/enc/transcript.jsonl\0', map),
    ).toThrow(NomadFatal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('is in NEVER_SYNC'));
  });

  it('permits config (settings.json, hooks/) under a .claude extra', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.claude/settings.json\0', map),
    ).not.toThrow();
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.claude/hooks/foo.cjs\0', map),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does NOT block a .claude file when the LOGICAL name collides with a NEVER_SYNC token', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    // A project legitimately named `sessions` (a NEVER_SYNC token). Only content
    // segments under <dirname> are scanned, so its own settings.json must pass
    // even though the logical equals a denied token.
    const collisionMap: PathMap = { projects: {}, extras: { sessions: ['.claude'] } };
    expect(() =>
      enforceAllowList('A  shared/extras/sessions/.claude/settings.json\0', collisionMap),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still permits the SAME ephemeral name (todos/) under a .planning extra (subset preserved)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    // Regression: the per-extra denylist must not leak the .claude widening
    // back onto .planning, whose todos/ remains legitimate GSD content.
    expect(() =>
      enforceAllowList('A  shared/extras/foo/.planning/todos/t.md\0', map),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
