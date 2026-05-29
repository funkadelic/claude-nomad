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

  it('permits shared/hooks/foo.sh via the static PUSH_ALLOWED_STATIC prefix', async () => {
    // shared/hooks/ was added to PUSH_ALLOWED_STATIC in plan 25-01; it is a
    // static allow-list entry, so no sharedDirs map entry is needed.
    const { enforceAllowList } = await import('./commands.push.allowlist.ts');
    const { NomadFatal } = await import('./utils.ts');
    const map: PathMap = { projects: {} };
    // Should NOT throw for shared/hooks/foo.sh
    expect(() => enforceAllowList('M  shared/hooks/foo.sh\0', map)).not.toThrow();
    // The static entry does not grant shared/hooks itself without trailing slash.
    expect(() => enforceAllowList('M  shared/other/file.sh\0', map)).toThrow(NomadFatal);
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
