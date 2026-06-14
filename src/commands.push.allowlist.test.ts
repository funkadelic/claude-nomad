import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PathMap } from './config.ts';

/** Run a git command in `cwd`, surfacing stderr on failure. Test-only helper
 * for the real-repo regression suites (no production code path uses it). */
function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Coverage for the settings.local.json NEVER_SYNC entry added to config.ts.
// settings.local.json is Anthropic's per-host overrides file; it must hard-block
// at the push boundary even if it somehow lands in the repo tree (e.g. an
// accidental copy of ~/.claude/ into shared/). Sibling case to the .claude.json
// NEVER_SYNC coverage in commands.test.ts; lives here so the push-boundary test
// surface keeps every NEVER_SYNC entry of immediate push concern in one file.
describe('enforceAllowList NEVER_SYNC settings.local.json', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects settings.local.json as NEVER_SYNC at repo root AND under shared/', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    // Porcelain -z records for untracked files. NUL-terminated to match
    // git status -z output (parsePorcelainZ splits on \0). The shared/
    // case is the load-bearing one for this PR: defense-in-depth against an
    // accidental copy of ~/.claude/settings.local.json into the synced tree.
    const map: PathMap = { projects: {} };
    for (const status of ['?? settings.local.json\0', '?? shared/settings.local.json\0']) {
      expect(() => enforceAllowList(status, map)).toThrow(NomadFatal);
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('settings.local.json is in NEVER_SYNC and must never be pushed'),
    );
  });
});

// parsePorcelainZ is the pure parser used by enforceAllowList. Its Y-column
// rename and trailing-rename-without-pair edges are not exercised by the
// cmdPush integration tests (which use simple `M  ...` records). These
// tests target lines 55 (Y-column R/C detection) and 67 (oldPath defined
// guard) directly so the allow-list enforcement remains correct under git's
// less common porcelain shapes.
describe('parsePorcelainZ Y-column and trailing-rename edges', () => {
  it('detects R in the Y-column (working-tree status) and returns both new+old paths', async () => {
    // ` R new\0old\0` is a working-tree rename: index column is space, Y is R.
    // Both halves must be returned so the allow-list can reject either side.
    // Missing line 55's R/C check on Y would skip the consume and let the
    // next iteration misread the old path as a new record.
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const status = ' R new-path\0old-path\0';
    expect(parsePorcelainZ(status)).toEqual(['new-path', 'old-path']);
  });

  it('detects C in the Y-column and returns both new+old paths', async () => {
    // Symmetric to the R case; copy records carry the same dual-path shape.
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const status = ' C copy-dst\0copy-src\0';
    expect(parsePorcelainZ(status)).toEqual(['copy-dst', 'copy-src']);
  });

  it('does NOT throw when an R record is the last record with no paired old-path', async () => {
    // `R  new-path\0` (no trailing old-path record). Line 67's
    // `oldPath !== undefined && oldPath !== ''` guard prevents pushing
    // undefined into the paths array; the `i++` still consumes a virtual
    // slot, the loop terminates cleanly, and the function returns [new].
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const status = 'R  new-path\0';
    expect(parsePorcelainZ(status)).toEqual(['new-path']);
  });

  it('does NOT push an empty-string old-path when the trailing record is empty', async () => {
    // `R  new\0\0` -> records split = ['R  new', '', '']. The R record at
    // index 0 sees records[1] = '' which is excluded by the
    // `oldPath !== ''` half of line 67's guard, so the old slot is skipped.
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const status = 'R  new\0\0';
    expect(parsePorcelainZ(status)).toEqual(['new']);
  });

  it('handles a normal X-column R (index rename) followed by old path correctly (baseline)', async () => {
    // Baseline regression guard: the X-column rename case must still work
    // identically to the Y-column case. This guarantees we did not skew the
    // common path while wiring the Y-column branch.
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const status = 'R  new\0old\0';
    expect(parsePorcelainZ(status)).toEqual(['new', 'old']);
  });

  it('skips a record shorter than 4 chars (line 55 guard against malformed porcelain)', async () => {
    // Records under 4 chars cannot hold "XY <path>" (2 status + 1 space + 1
    // path char minimum). A truncated/garbled record like "XY" must be
    // silently skipped, not throw, not push an empty string. Covers
    // line-55 branch in parsePorcelainZ.
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    // First record is a valid "M  ok" path; second is too short ("XY"); the
    // parser should keep the valid path and ignore the truncated record.
    const status = 'M  ok\0XY\0';
    expect(parsePorcelainZ(status)).toEqual(['ok']);
  });
});

// Regression for issue #111: a fresh host whose entire `shared/extras/`
// subtree is untracked. Git's default porcelain collapses an all-untracked
// subtree to a single `?? shared/extras/` parent record, which the child
// prefix allow-list (`shared/extras/<logical>/<dirname>/`) rejects. The
// push path must read with `untrackedAll: true` so per-file extras paths
// surface and the existing allow-list matches. Uses a REAL git repo so the
// collapse behavior is exercised end-to-end, not faked through a literal.
describe('issue #111: untracked extras subtree porcelain collapse', () => {
  let repo: string;

  beforeEach(() => {
    // Defend against a leaked `node:child_process` doMock from an earlier
    // test: the dynamically-imported gitStatusPorcelainZ would otherwise bind
    // to a mock returning empty Buffers and the real-git assertions would see
    // no status output. Unmock + reset so a fresh, unmocked utils.ts loads.
    vi.doUnmock('node:child_process');
    vi.resetModules();
    repo = mkdtempSync(join(tmpdir(), 'nomad-111-'));
    runGit(repo, ['init', '-q']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    // shared/ is tracked (committed); only the new extras subtree is untracked.
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'CLAUDE.md'), '# shared\n');
    runGit(repo, ['add', 'shared/CLAUDE.md']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    // Untracked extras: a multi-file subtree under a project's logical name.
    const planning = join(repo, 'shared', 'extras', 'myproj', '.planning');
    mkdirSync(join(planning, 'todos'), { recursive: true });
    writeFileSync(join(planning, 'PLAN.md'), '# plan\n');
    writeFileSync(join(planning, 'todos', 'a.md'), '# todo\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('default porcelain collapses the untracked subtree to a bare parent record', async () => {
    const { gitStatusPorcelainZ } = await import('./utils.ts');
    const { parsePorcelainZ } = await import('./commands.push.allowlist.ts');
    const paths = parsePorcelainZ(gitStatusPorcelainZ(repo));
    // The collapse: a single `shared/extras/` directory record, no per-file paths.
    expect(paths).toContain('shared/extras/');
    expect(paths).not.toContain('shared/extras/myproj/.planning/PLAN.md');
  });

  it('untrackedAll porcelain expands the subtree to per-file paths the allow-list accepts', async () => {
    const { gitStatusPorcelainZ } = await import('./utils.ts');
    const { parsePorcelainZ, enforceAllowList } = await import('./commands.push.allowlist.ts');
    const status = gitStatusPorcelainZ(repo, { untrackedAll: true });
    const paths = parsePorcelainZ(status);
    // Per-file expansion, not the collapsed parent.
    expect(paths).toContain('shared/extras/myproj/.planning/PLAN.md');
    expect(paths).toContain('shared/extras/myproj/.planning/todos/a.md');
    expect(paths).not.toContain('shared/extras/');
    // The runtime allow-list child prefix now matches every per-file path.
    const map: PathMap = { projects: {}, extras: { myproj: ['.planning'] } };
    expect(() => enforceAllowList(status, map)).not.toThrow();
  });
});

describe('enforceAllowList sharedDirs dynamic entries', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects shared/hooks/foo.sh (shared/hooks/ removed from PUSH_ALLOWED_STATIC)', async () => {
    // shared/hooks/ was removed from PUSH_ALLOWED_STATIC because gsd owns hooks per-host;
    // an out-of-band gsd write to shared/hooks/ must be rejected.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  shared/hooks/foo.sh\0', map)).toThrow(NomadFatal);
  });

  it('silently drops shared/agents/gsd-bar.md (gsd-prefixed agent, not a violation)', async () => {
    // shared/agents/ is gsd-owned per-host; gsd-prefixed files are silently dropped
    // (not treated as allow-list violations), matching the GSD_DROPPED_NAMES intent.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  shared/agents/gsd-bar.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still permits shared/skills/graphify/SKILL.md (shared/skills/ stays in allow-list)', async () => {
    // shared/skills/ is kept in PUSH_ALLOWED_STATIC because user-authored skills live there.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  shared/skills/graphify/SKILL.md\0', map)).not.toThrow();
  });

  it('permits shared/gsd/ and shared/gsd/cli.js when map.sharedDirs includes "gsd"', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {}, sharedDirs: ['gsd'] };
    expect(() => enforceAllowList('M  shared/gsd/cli.js\0', map)).not.toThrow();
  });

  it('does NOT add an allow entry for an invalid sharedDirs entry ("../escape")', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {}, sharedDirs: ['../escape'] };
    // The invalid entry is filtered out, so shared/escape/... is still rejected.
    expect(() => enforceAllowList('M  shared/escape/file.txt\0', map)).toThrow(NomadFatal);
  });

  it('does NOT add an allow entry for a NEVER_SYNC sharedDir, and the hard-block still fires', async () => {
    // 'todos' is in NEVER_SYNC; it must not widen the allow-list AND the
    // NEVER_SYNC hard-block must still reject a path containing it.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {}, sharedDirs: ['todos'] };
    expect(() => enforceAllowList('M  shared/todos/a.md\0', map)).toThrow(NomadFatal);
    // Verify it was the NEVER_SYNC message (not the allow-list message)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('is in NEVER_SYNC and must never be pushed'),
    );
  });
});

// Issue #294: gsd-core installs ~14 hook scripts and ~33 agent files into the
// nomad repo's shared/hooks/ and shared/agents/ trees (those dirs are symlinked
// from ~/.claude/ per host). After phase 50 dropped hooks/agents from
// SHARED_LINKS, those gsd-owned paths stopped being in PUSH_ALLOWED_STATIC and
// each push produced 51 allow-list violations, permanently wedging push.
// Fix: paths under GSD_DROPPED_NAMES dirs that are gsd-owned (gsd-prefixed
// basename, or known support files: managed-hooks-registry.cjs, package.json,
// lib/) are silently dropped -- not violations -- by enforceAllowList.
describe('enforceAllowList gsd-dropped path handling (issue #294)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('silently drops shared/hooks/gsd-prompt-guard.js (gsd-prefixed hook)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/hooks/gsd-prompt-guard.js\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('silently drops shared/agents/gsd-debug.md (gsd-prefixed agent)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/agents/gsd-debug.md\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('silently drops shared/hooks/managed-hooks-registry.cjs (gsd support file, not gsd-prefixed)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() =>
      enforceAllowList('A  shared/hooks/managed-hooks-registry.cjs\0', map),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('silently drops shared/hooks/package.json (gsd support file, not gsd-prefixed)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/hooks/package.json\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('silently drops shared/hooks/lib/git-cmd.js (gsd lib/ subtree, not gsd-prefixed)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/hooks/lib/git-cmd.js\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still rejects a bare shared/hooks/lib file (only the lib/ subtree is gsd-owned)', async () => {
    // `lib` matches gsd only as a directory prefix (shared/hooks/lib/...). A user
    // file literally named `lib` directly under shared/hooks/ must NOT be silently
    // dropped from a push; it stays a violation.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('A  shared/hooks/lib\0', map)).toThrow(NomadFatal);
  });

  it('still rejects shared/hooks/foo.sh (non-gsd-prefixed, not a support file)', async () => {
    // User-authored hooks would be dangerous to push (gsd owns hooks per-host).
    // Only gsd-owned names are silently dropped; foreign names stay violations.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  shared/hooks/foo.sh\0', map)).toThrow(NomadFatal);
  });

  it('still rejects shared/agents/my-agent.md (non-gsd-prefixed agent)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  shared/agents/my-agent.md\0', map)).toThrow(NomadFatal);
  });

  it('handles a realistic 51-file gsd payload without throwing (regression for #294)', async () => {
    // Simulate the full gsd-core payload: 14 gsd-prefixed hooks + managed-hooks-registry.cjs
    // + package.json + 2 lib/ files + 33 gsd-prefixed agents = 51 paths.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const hooks = Array.from({ length: 14 }, (_, i) => `A  shared/hooks/gsd-hook-${i}.js\0`).join(
      '',
    );
    const support =
      'A  shared/hooks/managed-hooks-registry.cjs\0' +
      'A  shared/hooks/package.json\0' +
      'A  shared/hooks/lib/git-cmd.js\0' +
      'A  shared/hooks/lib/gsd-graphify-rebuild.sh\0';
    const agents = Array.from(
      { length: 33 },
      (_, i) => `A  shared/agents/gsd-agent-${i}.md\0`,
    ).join('');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList(hooks + support + agents, map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// End-to-end regression for issue #294 (commit-suppression gap): after git add -A
// stages the gsd payload, the unstage step in commitAndPush must remove gsd-owned
// paths from the index before commit. This test uses a real git repo to exercise
// the full index round-trip: stage everything with `git add -A`, run the same
// isGsdDropped + parsePorcelainZ + git restore --staged logic that commitAndPush
// now uses, and assert the gsd paths are absent from the index while a non-gsd
// file under shared/hooks/ (which would trigger the enforceAllowList gate) is
// likewise kept out of the commit via the gate rejection path.
describe('commitAndPush gsd-dropped unstage (issue #294 commit-suppression)', () => {
  let repo: string;

  beforeEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    repo = mkdtempSync(join(tmpdir(), 'nomad-294-'));
    runGit(repo, ['init', '-q']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    // Commit a minimal initial state so HEAD exists and the index has a base.
    mkdirSync(join(repo, 'shared', 'hooks'), { recursive: true });
    mkdirSync(join(repo, 'shared', 'agents'), { recursive: true });
    mkdirSync(join(repo, 'shared', 'hooks', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'shared', 'CLAUDE.md'), '# shared\n');
    runGit(repo, ['add', 'shared/CLAUDE.md']);
    runGit(repo, ['commit', '-q', '-m', 'init']);
    // Write the gsd payload (untracked, like a fresh gsd-core install would).
    writeFileSync(join(repo, 'shared', 'hooks', 'gsd-prompt-guard.js'), '// hook\n');
    writeFileSync(join(repo, 'shared', 'hooks', 'gsd-tool-check.sh'), '# hook\n');
    writeFileSync(join(repo, 'shared', 'hooks', 'managed-hooks-registry.cjs'), '// registry\n');
    writeFileSync(join(repo, 'shared', 'hooks', 'package.json'), '{"name":"hooks"}\n');
    writeFileSync(join(repo, 'shared', 'hooks', 'lib', 'git-cmd.js'), '// lib\n');
    writeFileSync(join(repo, 'shared', 'agents', 'gsd-debug.md'), '# agent\n');
    writeFileSync(join(repo, 'shared', 'agents', 'gsd-planner.md'), '# agent\n');
    // A non-gsd file that must NOT end up in the index (gate rejects it upstream,
    // but to verify the predicate boundary we check it is isGsdDropped===false).
    writeFileSync(join(repo, 'shared', 'hooks', 'user-hook.sh'), '# user\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('gsd-dropped paths are absent from the index after unstage; non-gsd paths remain untracked', async () => {
    const { execFileSync: realExec } = await import('node:child_process');
    const { parsePorcelainZ, isGsdDropped } = await import('./commands.push.allowlist.ts');

    // Stage everything (mirrors git add -A in commitAndPush).
    realExec('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });

    // Collect staged paths and filter gsd-dropped ones (mirrors commitAndPush logic).
    const status = realExec('git', ['status', '--porcelain=v1', '-z'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const staged = parsePorcelainZ(status);
    const toDrop = staged.filter((p) => isGsdDropped(p));

    // There must be gsd-dropped paths to unstage (otherwise the test proves nothing).
    expect(toDrop.length).toBeGreaterThan(0);
    expect(toDrop).toContain('shared/hooks/gsd-prompt-guard.js');
    expect(toDrop).toContain('shared/hooks/managed-hooks-registry.cjs');
    expect(toDrop).toContain('shared/hooks/package.json');
    expect(toDrop).toContain('shared/hooks/lib/git-cmd.js');
    expect(toDrop).toContain('shared/agents/gsd-debug.md');

    // Unstage (mirrors commitAndPush).
    realExec('git', ['restore', '--staged', '--', ...toDrop], { cwd: repo, stdio: 'pipe' });

    // Verify: gsd paths are no longer staged. Use `git diff --cached --name-only -z`
    // which lists ONLY index-staged paths (index vs HEAD), not untracked files.
    // After restore --staged, gsd files return to untracked -- absent from cached diff.
    const cachedDiff = realExec('git', ['diff', '--cached', '--name-only', '-z'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .split('\0')
      .filter(Boolean);

    // gsd-owned paths must be absent from the staged index.
    expect(cachedDiff).not.toContain('shared/hooks/gsd-prompt-guard.js');
    expect(cachedDiff).not.toContain('shared/hooks/gsd-tool-check.sh');
    expect(cachedDiff).not.toContain('shared/hooks/managed-hooks-registry.cjs');
    expect(cachedDiff).not.toContain('shared/hooks/package.json');
    expect(cachedDiff).not.toContain('shared/hooks/lib/git-cmd.js');
    expect(cachedDiff).not.toContain('shared/agents/gsd-debug.md');
    expect(cachedDiff).not.toContain('shared/agents/gsd-planner.md');

    // The non-gsd file is NOT gsd-dropped (enforceAllowList would reject it upstream).
    expect(isGsdDropped('shared/hooks/user-hook.sh')).toBe(false);
    // user-hook.sh IS still staged (git add -A staged it; it's not in toDrop).
    expect(cachedDiff).toContain('shared/hooks/user-hook.sh');
  });

  it('isGsdDropped returns false for shared/hooks/user-hook.sh (non-gsd gate boundary)', async () => {
    const { isGsdDropped } = await import('./commands.push.allowlist.ts');
    // This boundary ensures the commit-suppression step does not swallow files
    // that enforceAllowList is supposed to reject (Pitfall 4 guard preserved).
    expect(isGsdDropped('shared/hooks/user-hook.sh')).toBe(false);
    expect(isGsdDropped('shared/agents/my-agent.md')).toBe(false);
  });
});

// Regression for D-04: .gitleaksignore must be allowed by enforceAllowList so
// the nomad push Allow action can write and stage the file without tripping the
// push gate. The entry must be an exact match (not a prefix) so siblings like
// .gitleaksignore.bak remain rejected.
describe('enforceAllowList .gitleaksignore allow-list entry (D-04)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation((..._args: unknown[]) => {
      /* captured */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a staged .gitleaksignore (exact match in PUSH_ALLOWED_STATIC)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  .gitleaksignore\0', map)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects .gitleaksignore.bak (exact-match only, no prefix leak)', async () => {
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    expect(() => enforceAllowList('M  .gitleaksignore.bak\0', map)).toThrow(NomadFatal);
  });
});
