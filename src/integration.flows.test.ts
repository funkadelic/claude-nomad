import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodePath } from './utils.json.ts';
import { g, gitOut, plantLocalSession } from './test-support/git.ts';
import { type Host, makeWorld, runNomad } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. Gates the whole
 * describe so a host without git skips cleanly instead of failing with an
 * unhelpful spawn error.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Returns `true` when the `gitleaks` binary is present on PATH. Every flow here
 * drives the real `nomad push`/`nomad redact`/`nomad sync` pipeline, which
 * hard-requires gitleaks. CI installs it; the npm-publish prepublishOnly hook
 * runs the suite without it, so gate the describe to skip cleanly there rather
 * than failing the release.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The logical project name mapped across both hosts in every flow below. */
const LOGICAL = 'myproject';
/** A second logical project mapped to host A only, used to advance origin without
 * touching host B's project dir (so a stale B can rebase without a mirror clash). */
const OTHER = 'other';

/**
 * The pieces a flow test needs after host A is bootstrapped: the shared origin,
 * the `makeHost` factory (to mint host B), the initialized host A, and the two
 * hosts' distinct project roots (which encode to different session-dir keys).
 */
type Bootstrap = {
  origin: string;
  makeHost: (name: string) => Host;
  a: Host;
  projectRoot: string;
  bProjectRoot: string;
  /** Host A's root for the host-A-only `OTHER` project. */
  otherRoot: string;
};

/**
 * Stand up a shared origin and an initialized host A whose committed, pushed
 * scaffold maps logical `myproject` under BOTH `host-a` and `host-b`, so a
 * later `makeHost('host-b')` can clone the origin and immediately pull/push the
 * same logical project. Mirrors the first half of the round-trip journey but
 * stops before any session work so each flow drives its own push/pull/sync.
 *
 * @param tmp - Root temp directory; all output stays under it.
 * @returns The origin path, the `makeHost` factory, host A, and both project roots.
 */
function bootstrapHostA(tmp: string): Bootstrap {
  const { origin, makeHost } = makeWorld(tmp);
  const a = makeHost('host-a');

  // Seed host A's ~/.claude with the SHARED_LINK target and settings precursor
  // that `init --snapshot` captures into shared/settings.base.json + hosts/.
  mkdirSync(a.claudeHome, { recursive: true });
  writeFileSync(join(a.claudeHome, 'CLAUDE.md'), '# shared claude md\n');
  writeFileSync(join(a.claudeHome, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');

  const projectRoot = join(tmp, LOGICAL);
  const bProjectRoot = join(tmp, 'host-b', LOGICAL);
  const otherRoot = join(tmp, OTHER);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(otherRoot, { recursive: true });

  // --keep-actions prevents the gh-actions disable flow from running in CI.
  const init = runNomad(a, ['init', '--snapshot', '--keep-actions']);
  expect(init.status, `init failed:\n${init.stderr}`).toBe(0);

  // Map `myproject` under both hosts (distinct paths so encodePath produces a
  // different session-dir key per host), plus `other` under host A only.
  writeFileSync(
    join(a.repo, 'path-map.json'),
    JSON.stringify({
      projects: {
        [LOGICAL]: { 'host-a': projectRoot, 'host-b': bProjectRoot },
        [OTHER]: { 'host-a': otherRoot },
      },
    }) + '\n',
  );

  // Commit and push the whole scaffold so a later host-b clone sees it. A human
  // reviews the init scaffold before committing; the test does it inline.
  g(['add', '-A'], a.repo);
  g(['commit', '-q', '-m', 'nomad init scaffold'], a.repo);
  g(['push', '-q', 'origin', 'main'], a.repo);

  return { origin, makeHost, a, projectRoot, bProjectRoot, otherRoot };
}

/** Absolute path of a planted session under a host's ~/.claude for a project root. */
function sessionPath(host: Host, projectRoot: string, sid: string): string {
  return join(host.claudeHome, 'projects', encodePath(projectRoot), `${sid}.jsonl`);
}

/** Repo-side path of a synced session inside the shared origin clone `verify`. */
function publishedPath(verifyRepo: string, sid: string): string {
  return join(verifyRepo, 'shared', 'projects', LOGICAL, `${sid}.jsonl`);
}

describe.skipIf(!hasGit || !hasGitleaks)('multi-host sync flows (real git + real gitleaks)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-flows-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pull retains an unpushed local-only session while overwriting the repo-tracked one', () => {
    const { makeHost, a, projectRoot, bProjectRoot } = bootstrapHostA(tmp);

    // A publishes a session, then B clones and pulls it.
    const sidA = plantLocalSession(a.home, projectRoot, '{"role":"user","text":"A v1"}\n');
    expect(runNomad(a, ['push']).status).toBe(0);

    const b = makeHost('host-b');
    expect(runNomad(b, ['pull']).status).toBe(0);
    expect(existsSync(sessionPath(b, bProjectRoot, sidA)), 'A session not on B after pull').toBe(
      true,
    );

    // B plants its own local-only session in the SAME encoded project dir and
    // never pushes it. This is the eviction-risk file.
    const localOnly = '{"role":"user","text":"B local only"}\n';
    const sidB = plantLocalSession(b.home, bProjectRoot, localOnly);

    // A updates the tracked session and re-pushes, so B's next pull re-copies
    // the project dir (the moment the old whole-dir mirror would have evicted
    // sidB).
    writeFileSync(sessionPath(a, projectRoot, sidA), '{"role":"user","text":"A v2"}\n');
    expect(runNomad(a, ['push']).status).toBe(0);

    expect(runNomad(b, ['pull']).status).toBe(0);

    // Tracked session updated to v2; local-only session survived untouched.
    expect(readFileSync(sessionPath(b, bProjectRoot, sidA), 'utf8')).toBe(
      '{"role":"user","text":"A v2"}\n',
    );
    expect(
      existsSync(sessionPath(b, bProjectRoot, sidB)),
      'local-only session was evicted by the pull',
    ).toBe(true);
    expect(readFileSync(sessionPath(b, bProjectRoot, sidB), 'utf8')).toBe(localOnly);
  });

  it('blocks a secret on push, clears it with nomad redact, then re-pushes without leaking it', () => {
    const { origin, a, projectRoot } = bootstrapHostA(tmp);

    // Assemble a high-entropy PAT at runtime so no contiguous secret sits in
    // source bytes; the staged-tree scan still fires on it.
    const fakePat = ['gh', 'p_', 'BCcU4rgWmX3aPlSt9bN6yKzD7vH2eF8oG1qZ'].join('');
    const sid = plantLocalSession(a.home, projectRoot, `{"role":"user","text":"tok=${fakePat}"}\n`);

    // Backdate the transcript past redact's 5-minute live-session guard, which
    // refuses to rewrite a possibly-active session. A just-planted file is
    // seconds old; a real session queued for redaction is not.
    const old = Date.now() / 1000 - 10 * 60;
    utimesSync(sessionPath(a, projectRoot, sid), old, old);

    const before = gitOut(['rev-list', '--count', 'main'], origin);

    // Non-TTY push: the leak verdict aborts (exit 1), nothing is committed or pushed.
    const blocked = runNomad(a, ['push']);
    expect(blocked.status, 'push should have blocked on the secret').toBe(1);
    expect(gitOut(['rev-list', '--count', 'main'], origin)).toBe(before);

    // Non-interactive redaction rewrites the secret span in the local transcript.
    const redact = runNomad(a, ['redact', sid]);
    expect(redact.status, `redact failed:\n${redact.stderr}`).toBe(0);
    const local = readFileSync(sessionPath(a, projectRoot, sid), 'utf8');
    expect(local, 'secret still present after redact').not.toContain(fakePat);
    expect(local, 'redaction placeholder missing').toContain('[REDACTED:');

    // Re-push now passes the scan and publishes the redacted transcript.
    const repush = runNomad(a, ['push']);
    expect(repush.status, `re-push failed:\n${repush.stderr}`).toBe(0);

    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(existsSync(publishedPath(verify, sid)), 'redacted transcript not published').toBe(true);
    expect(
      readFileSync(publishedPath(verify, sid), 'utf8'),
      'secret reached the repo',
    ).not.toContain(fakePat);
  });

  it('propagates B -> A after B rebases its stale push onto A (both sessions land)', () => {
    const { origin, makeHost, a, projectRoot, bProjectRoot, otherRoot } = bootstrapHostA(tmp);

    // Both hosts start at the scaffold commit. A will advance origin on the
    // host-A-only `other` project; B holds a myproject session. The push-side
    // session copy mirror-replaces a project dir, so A and B pushing DIFFERENT
    // projects lets B rebase onto A's commit without clobbering it (two hosts
    // racing the SAME project is last-write-wins by design and is covered by the
    // sync/round-trip flows).
    const b = makeHost('host-b');
    const sidO = plantLocalSession(a.home, otherRoot, '{"role":"user","text":"from A other"}\n');
    const sidB = plantLocalSession(b.home, bProjectRoot, '{"role":"user","text":"from B"}\n');

    // A advances origin first. B is now genuinely stale, so its push must rebase
    // onto A's commit before it can land (a push-rebase regression fails here).
    expect(runNomad(a, ['push']).status).toBe(0);
    expect(runNomad(b, ['push']).status).toBe(0);

    // Origin carries BOTH pushes: B's push rebased onto A's `other` commit rather
    // than replacing it.
    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(
      existsSync(join(verify, 'shared', 'projects', OTHER, `${sidO}.jsonl`)),
      "A's other-project session missing from origin (B's push did not rebase)",
    ).toBe(true);
    expect(existsSync(publishedPath(verify, sidB)), 'B session missing from origin').toBe(true);

    // Reverse direction: A pulls and sees the session authored on B.
    expect(runNomad(a, ['pull']).status).toBe(0);
    expect(existsSync(sessionPath(a, projectRoot, sidB)), 'B session did not reach A').toBe(true);
    expect(readFileSync(sessionPath(a, projectRoot, sidB), 'utf8')).toBe(
      '{"role":"user","text":"from B"}\n',
    );
  });

  it('nomad sync pulls incoming sessions and pushes local work under one command', () => {
    const { origin, makeHost, a, projectRoot, bProjectRoot } = bootstrapHostA(tmp);

    // A publishes sidA.
    const sidA = plantLocalSession(a.home, projectRoot, '{"role":"user","text":"from A"}\n');
    expect(runNomad(a, ['push']).status).toBe(0);

    // B joins with an unpushed local session already planted, then runs a single
    // `nomad sync`: the pull half must bring sidA down and the push half must
    // send sidB up, in one invocation.
    const b = makeHost('host-b');
    const sidB = plantLocalSession(b.home, bProjectRoot, '{"role":"user","text":"from B"}\n');

    const sync = runNomad(b, ['sync']);
    expect(sync.status, `sync failed:\n${sync.stderr}`).toBe(0);

    // Pull half landed A's session on B.
    expect(
      existsSync(sessionPath(b, bProjectRoot, sidA)),
      'sync pull half did not fetch sidA',
    ).toBe(true);

    // Push half sent B's session to origin.
    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(existsSync(publishedPath(verify, sidB)), 'sync push half did not publish sidB').toBe(
      true,
    );
  });

  it('pull --dry-run and diff preview pending work without mutating ~/.claude', () => {
    const { makeHost, a, projectRoot, bProjectRoot } = bootstrapHostA(tmp);
    const sidA = plantLocalSession(a.home, projectRoot, '{"role":"user","text":"from A"}\n');
    expect(runNomad(a, ['push']).status).toBe(0);

    const b = makeHost('host-b');

    // The artifacts a real pull on B would create: a CLAUDE.md link, a merged
    // settings.json, and the remapped session under B's encoded project dir.
    const bClaudeMd = join(b.claudeHome, 'CLAUDE.md');
    const bSettings = join(b.claudeHome, 'settings.json');
    const bSession = sessionPath(b, bProjectRoot, sidA);

    // diff is the offline, lockless preview; pull --dry-run is the online one.
    const diff = runNomad(b, ['diff']);
    expect(diff.status, `diff failed:\n${diff.stderr}`).toBe(0);
    const dry = runNomad(b, ['pull', '--dry-run']);
    expect(dry.status, `pull --dry-run failed:\n${dry.stderr}`).toBe(0);

    // Both previews must actually describe the pending work, not just exit 0: the
    // Symlinks section names the CLAUDE.md link and the Sessions section names
    // the mapped project copy. Otherwise an empty preview would pass this test.
    for (const [label, out] of [
      ['diff', diff.stdout],
      ['pull --dry-run', dry.stdout],
    ] as const) {
      expect(out, `${label} did not preview the CLAUDE.md link`).toMatch(
        /Symlinks[\s\S]*CLAUDE\.md/,
      );
      expect(out, `${label} did not preview the session copy`).toMatch(/Sessions[\s\S]*myproject/);
    }

    // ...while touching nothing on disk.
    expect(existsSync(bClaudeMd), 'preview created a shared link').toBe(false);
    expect(existsSync(bSettings), 'preview wrote settings.json').toBe(false);
    expect(existsSync(bSession), 'preview copied a session transcript').toBe(false);

    // A real pull then materializes exactly what the previews described, proving
    // they were previewing genuine pending work, not an empty no-op.
    expect(runNomad(b, ['pull']).status).toBe(0);
    expect(existsSync(bClaudeMd), 'real pull did not create the link').toBe(true);
    expect(existsSync(bSettings), 'real pull did not write settings.json').toBe(true);
    expect(existsSync(bSession), 'real pull did not copy the session').toBe(true);
  });

  it('writes the push manifest after a successful push and no-ops an unchanged second push', () => {
    const { origin, a, projectRoot } = bootstrapHostA(tmp);
    // Manifest path mirrors config.ts: ~/.cache/claude-nomad/push-manifest-<HOST>.json.
    const manifest = join(a.home, '.cache', 'claude-nomad', 'push-manifest-host-a.json');

    // The scaffold reached origin via a raw git push, so no nomad manifest exists yet.
    expect(existsSync(manifest), 'manifest present before any nomad push').toBe(false);

    const sid = plantLocalSession(a.home, projectRoot, '{"role":"user","text":"from A"}\n');
    expect(runNomad(a, ['push']).status).toBe(0);
    // Written only after `git push` returned 0.
    expect(existsSync(manifest), 'manifest not written after successful push').toBe(true);

    const afterFirst = gitOut(['rev-list', '--count', 'main'], origin);

    // A second push with nothing changed is a clean no-op: the incremental
    // manifest finds no new or changed transcript, so origin never advances.
    expect(runNomad(a, ['push']).status).toBe(0);
    expect(
      gitOut(['rev-list', '--count', 'main'], origin),
      'unchanged second push advanced origin',
    ).toBe(afterFirst);

    const verify = join(tmp, 'verify');
    g(['clone', '-q', origin, verify], tmp);
    expect(existsSync(publishedPath(verify, sid)), 'session not published exactly once').toBe(true);
  });

  it('nomad eject materializes managed symlinks to real copies and leaves the repo untouched', () => {
    const { makeHost } = bootstrapHostA(tmp);

    // No session needed: eject only concerns the managed shared links that the
    // scaffold push already published, so B's pull materializes CLAUDE.md.
    const b = makeHost('host-b');
    expect(runNomad(b, ['pull']).status).toBe(0);

    const bClaudeMd = join(b.claudeHome, 'CLAUDE.md');
    // readFileSync both proves the pull created the link and captures the
    // pre-eject content in one step; a separate existsSync check followed by a
    // read is a file-system race (flagged by CodeQL js/file-system-race).
    const contentBefore = readFileSync(bClaudeMd, 'utf8');

    // Snapshot the sync repo so eject can be proven to never touch it.
    const repoHeadBefore = gitOut(['rev-parse', 'HEAD'], b.repo);
    const repoStatusBefore = gitOut(['status', '--porcelain'], b.repo);

    const eject = runNomad(b, ['eject']);
    expect(eject.status, `eject failed:\n${eject.stderr}`).toBe(0);

    // Read the content first, then stat: a stat check followed by a read of the
    // same path is a check-then-use file-system race (CodeQL js/file-system-race).
    expect(readFileSync(bClaudeMd, 'utf8'), 'ejected content differs').toBe(contentBefore);
    // The managed link is now a real (dereferenced) file, not a symlink. On
    // win32 it was already a real copy; the assertion holds on both.
    expect(lstatSync(bClaudeMd).isSymbolicLink(), 'CLAUDE.md still a symlink after eject').toBe(
      false,
    );

    // The sync repo is untouched: same HEAD, clean working tree.
    expect(gitOut(['rev-parse', 'HEAD'], b.repo), 'eject moved repo HEAD').toBe(repoHeadBefore);
    expect(gitOut(['status', '--porcelain'], b.repo), 'eject dirtied the repo').toBe(
      repoStatusBefore,
    );
  });
});
