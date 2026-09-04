import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { g, gitInit, gitOut, makeBareOrigin, setTestIdentity } from './test-support/git.ts';
import { EXIT } from './exit-codes.ts';

/**
 * Regression coverage for the conflicted-autostash-pop guard, driven
 * against a REAL conflicted `git pull --rebase --autostash`. The bug this
 * closes was a wrong assumption about what git actually does (a 0 exit code
 * on a conflicted autostash pop), so a mock of `execFileSync` would have
 * passed against the buggy code too; only real git output exercises it.
 */

/**
 * Build a bare origin plus a `shared/settings.base.json` seed commit that
 * also carries a tracked file (`shared/conflict.txt`), at a single "base"
 * state. Callers diverge it further per scenario via {@link wedgedClone}.
 *
 * @param tmp - Parent temp directory for this test.
 * @returns Absolute path to the bare origin repo.
 */
function buildBaseOrigin(tmp: string): string {
  const origin = makeBareOrigin(tmp);

  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'shared'), { recursive: true });
  gitInit(seed);
  writeFileSync(join(seed, 'shared', 'settings.base.json'), '{}\n');
  writeFileSync(join(seed, 'shared', 'conflict.txt'), 'base\n');
  // A real SHARED_LINKS name (CLAUDE.md) so applySharedLinks has something
  // to symlink into ~/.claude/ if it ran; without this, applySharedLinks
  // skips every name silently (no shared/<name> counterpart), which would
  // make the "guard prevented applySharedLinks" assertion vacuously true.
  writeFileSync(join(seed, 'shared', 'CLAUDE.md'), '# shared\n');
  writeFileSync(join(seed, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'base'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  return origin;
}

/**
 * Clone `origin` at its CURRENT (base) state into a fresh directory named
 * `name` under `tmp`, THEN push a divergent edit to `shared/conflict.txt`
 * through an independent second clone so origin moves ahead of the clone
 * just made, and finally leave an uncommitted, differently-conflicting edit
 * to the same file in the clone's working tree. That ordering (clone first,
 * diverge origin second) is what makes the later edit conflict: cloning
 * AFTER the divergent push would already carry the upstream content, so
 * popping the local edit against it would apply cleanly instead of
 * conflicting. The uncommitted edit is exactly the `--autostash` input:
 * when the clone is later pulled, git stashes it, fast-forwards onto
 * origin's divergent commit, and the pop then conflicts on the same lines.
 *
 * @param tmp - Parent temp directory.
 * @param origin - Bare origin built by {@link buildBaseOrigin}.
 * @param name - Unique directory name for this clone (and its paired
 *   divergent-push clone, suffixed `-other`).
 * @returns Absolute path to the wedged-input clone.
 */
function wedgedClone(tmp: string, origin: string, name: string): string {
  const dir = join(tmp, name);
  g(['clone', '-q', origin, dir], tmp);
  setTestIdentity(dir);

  const other = join(tmp, `${name}-other`);
  g(['clone', '-q', origin, other], tmp);
  setTestIdentity(other);
  writeFileSync(join(other, 'shared', 'conflict.txt'), 'upstream edit\n');
  g(['add', '.'], other);
  g(['commit', '-q', '-m', 'upstream commit'], other);
  g(['push', '-q', 'origin', 'main'], other);

  writeFileSync(join(dir, 'shared', 'conflict.txt'), 'local edit\n');
  return dir;
}

/**
 * Clone `origin` into a fresh directory named `name` under `tmp` with no
 * local edits and no further divergence: the clean-pull control case.
 *
 * @param tmp - Parent temp directory.
 * @param origin - Bare origin built by {@link buildBaseOrigin}.
 * @param name - Unique directory name for this clone.
 * @returns Absolute path to the clean clone.
 */
function cleanClone(tmp: string, origin: string, name: string): string {
  const dir = join(tmp, name);
  g(['clone', '-q', origin, dir], tmp);
  setTestIdentity(dir);
  return dir;
}

describe('conflicted autostash pop (real git + real cmdPush/cmdPull call sites)', () => {
  let tmp: string;
  let origin: string;
  let originalHome: string | undefined;
  let originalNomadRepo: string | undefined;
  let originalNomadHost: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalNomadRepo = process.env.NOMAD_REPO;
    originalNomadHost = process.env.NOMAD_HOST;
    tmp = mkdtempSync(join(tmpdir(), 'nomad-autostash-e2e-'));
    process.env.NOMAD_HOST = 'test-host';
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* captured */
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    origin = buildBaseOrigin(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNomadRepo !== undefined) process.env.NOMAD_REPO = originalNomadRepo;
    else delete process.env.NOMAD_REPO;
    if (originalNomadHost !== undefined) process.env.NOMAD_HOST = originalNomadHost;
    else delete process.env.NOMAD_HOST;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('empirical precondition: a conflicted autostash pop exits 0 and leaves an unmerged index', () => {
    const probe = wedgedClone(tmp, origin, 'precondition-probe');
    // This is the whole bug: git reports success (exit 0, no throw) even
    // though the autostash it popped internally conflicted. `g()` throws on
    // a non-zero exit, so a throw here would mean git's behavior changed
    // and the rest of this file's assumptions no longer hold.
    expect(() => g(['pull', '--rebase', '--autostash'], probe)).not.toThrow();
    const unmerged = gitOut(['diff', '--diff-filter=U', '--name-only'], probe);
    expect(unmerged).toContain('conflict.txt');
  });

  it('rebaseBeforePush throws EXIT.CONFLICT with autostash wording, not torn-down-rebase wording', async () => {
    const local = wedgedClone(tmp, origin, 'push-target');
    process.env.HOME = tmp;
    // The pre-conflict tip, captured from the bare origin directly (not
    // from `local`, whose HEAD is about to sit mid-conflict): no commit
    // must land on top of this, whether from an errant `git add -A` /
    // `git commit` sequence downstream or from the throw itself.
    const preConflictTip = gitOut(['rev-parse', 'main'], origin);

    const { rebaseBeforePush } = await import('./commands/push/checks.ts');
    let caught: unknown;
    try {
      rebaseBeforePush(local);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(EXIT.CONFLICT);
    const message = (caught as Error).message;
    expect(message).toContain('nomad push');
    expect(message).toContain('autostash pop');
    // Not the torn-down-rebase wording from unmergedIndexRunbookText.
    expect(message).not.toContain('torn-down rebase');

    // The repo is observably unmutated past the pull: no commit landed on
    // top of the conflict, since the throw fires before any caller-side
    // copy or `git add -A` could resolve the unmerged entries and commit
    // the marker text.
    expect(gitOut(['rev-parse', 'HEAD'], local)).toBe(preConflictTip);
  });

  it('runPullCore throws before applySharedLinks runs, leaving ~/.claude/ untouched', async () => {
    const local = wedgedClone(tmp, origin, 'pull-target');
    process.env.HOME = tmp;
    process.env.NOMAD_REPO = local;

    const { runPullCore } = await import('./commands.pull.ts');
    let caught: unknown;
    try {
      runPullCore();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(EXIT.CONFLICT);
    expect((caught as Error).message).toContain('nomad pull');

    // applySharedLinks never ran: no shared name was materialized under
    // ~/.claude/ on this host.
    expect(existsSync(join(tmp, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('a clean pull does not throw on either the push or the pull call site', async () => {
    const pushLocal = cleanClone(tmp, origin, 'push-clean');
    const pullLocal = cleanClone(tmp, origin, 'pull-clean');
    process.env.HOME = tmp;

    const { rebaseBeforePush } = await import('./commands/push/checks.ts');
    expect(() => rebaseBeforePush(pushLocal)).not.toThrow();

    process.env.NOMAD_REPO = pullLocal;
    vi.resetModules();
    const { runPullCore } = await import('./commands.pull.ts');
    expect(() => runPullCore()).not.toThrow();
  });
});
