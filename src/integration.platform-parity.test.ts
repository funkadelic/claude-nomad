import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failGlyph } from './color.ts';
import { SHARED_LINKS } from './config.ts';
import { section } from './commands.doctor.format.ts';
import { g } from './test-support/git.ts';
import { makeWorld, runNomad } from './test-support/world.ts';

// ---------------------------------------------------------------------------
// Cross-platform parity
// ---------------------------------------------------------------------------
//
// Every test in this file asserts the same observable OUTCOME on both sync
// modalities and lets the REAL `process.platform` pick the branch: symlinks on
// posix, copy-sync on win32. Ubuntu therefore exercises the symlink path and
// windows-latest exercises the copy path under identical assertions, which is
// what turns the windows-latest CI leg into a genuine verification channel.
//
// NOTHING here may call `stubPlatform`. The rest of the suite covers the win32
// branches by stubbing `process.platform` while running on posix, so those
// assertions pass on a Windows runner without proving anything about it.
// Adding a platform stub to a test in this file defeats its entire purpose.
//
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the `git` binary is present on PATH. Gates the pull
 * journey below so a host without git skips cleanly instead of failing with an
 * unhelpful spawn error. The in-process describes below `git init` their own
 * sandbox repos and carry the same gate.
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
 * Returns `true` when the `gitleaks` binary is present on PATH. Gates the sync
 * journey below, whose push half hard-requires gitleaks. CI installs it; the
 * npm-publish prepublishOnly hook runs the suite without it, so the journey
 * skips cleanly there rather than failing the release. The pull journey above
 * drives no push and carries no such gate.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Shared-config content seeded into the repo before the host materializes it. */
const ORIGINAL_MD = '# shared claude md (from the repo)\n';
/** The unpublished host-side edit whose survival across a pull is the invariant. */
const EDITED_MD = '# shared claude md (edited locally, not yet pushed)\n';
/**
 * A THIRD, distinct edit written after the second pull's mirror already ran.
 * Reusing EDITED_MD for the `--force-remote` pull below would make the
 * assertion a tautology: the repo working tree already carries EDITED_MD by
 * that point, so a pull that skipped the mirror entirely would still read
 * back the same bytes. Only an edit made AFTER the last mirror run
 * distinguishes "the mirror ran" from "the mirror was skipped and nothing
 * changed to notice."
 */
const FORCED_MD = '# shared claude md (edited again, clean repo, force-remote)\n';
/**
 * The edit host B publishes with `nomad sync`, and the exact bytes host A must
 * read back afterwards.
 */
const SYNCED_MD = '# shared claude md (edited on host B, published by nomad sync)\n';

describe.skipIf(!hasGit)('parity: pull preserves an unpublished shared-config edit', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomad-parity-pull-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('leaves the edit readable at ~/.claude and staged into shared/ on both modalities', () => {
    const { makeHost } = makeWorld(tmp);

    // Host A only exists to author the scaffold. The commit and push are raw
    // git rather than `nomad push` so this journey does not depend on gitleaks
    // being installed; the invariant under test is entirely pull-side.
    const a = makeHost('host-a');
    mkdirSync(a.claudeHome, { recursive: true });
    writeFileSync(join(a.claudeHome, 'CLAUDE.md'), ORIGINAL_MD);
    const initResult = runNomad(a, ['init', '--snapshot', '--keep-actions']);
    expect(initResult.status, `init failed:\n${initResult.stderr}`).toBe(0);
    g(['add', '-A'], a.repo);
    g(['commit', '-q', '-m', 'nomad init scaffold'], a.repo);
    g(['push', '-q', 'origin', 'main'], a.repo);

    // Host B is minted AFTER the push so its clone already carries the
    // scaffold. Its ~/.claude is empty, which is the state applySharedLinks
    // expects: on posix it plants a symlink, on win32 a real copy.
    const b = makeHost('host-b');
    const firstPull = runNomad(b, ['pull']);
    expect(firstPull.status, `first pull failed:\n${firstPull.stderr}`).toBe(0);
    const claudeMd = join(b.claudeHome, 'CLAUDE.md');
    expect(readFileSync(claudeMd, 'utf8'), 'shared config did not materialize on B').toBe(
      ORIGINAL_MD,
    );

    // The user edits their config in place and pulls before publishing it.
    writeFileSync(claudeMd, EDITED_MD);
    const secondPull = runNomad(b, ['pull']);
    expect(secondPull.status, `second pull failed:\n${secondPull.stderr}`).toBe(0);

    // Invariant 1: the edit is still what the host reads back. On posix the
    // symlink plus `git pull --rebase --autostash` carries it; on win32
    // mirrorSharedLinksBeforePull puts the host in that same pre-pull state.
    expect(readFileSync(claudeMd, 'utf8'), 'the pull reverted the local edit').toBe(EDITED_MD);

    // Invariant 2: the edit reached the repo working tree, so the next push
    // publishes it instead of republishing the pre-edit content. Deleting the
    // win32 mirror step fails here while posix stays green.
    expect(
      readFileSync(join(b.repo, 'shared', 'CLAUDE.md'), 'utf8'),
      'the local edit never reached shared/ in the repo',
    ).toBe(EDITED_MD);

    // A THIRD pull, this time with --force-remote on a clean repo (host B was
    // never wedged). This is the regression this file exists to prove: before
    // this phase, --force-remote unconditionally skipped the win32 mirror, so
    // this pull would have republished the repo's stale content over the
    // fresh edit below. After the fix, the mirror gate is keyed on whether a
    // wedge was actually recovered, not on the flag itself, so a clean repo
    // under --force-remote still runs the mirror.
    writeFileSync(claudeMd, FORCED_MD);
    const thirdPull = runNomad(b, ['pull', '--force-remote']);
    expect(thirdPull.status, `force-remote pull failed:\n${thirdPull.stderr}`).toBe(0);

    expect(
      readFileSync(claudeMd, 'utf8'),
      'the force-remote pull reverted the local edit on a clean repo',
    ).toBe(FORCED_MD);
    expect(
      readFileSync(join(b.repo, 'shared', 'CLAUDE.md'), 'utf8'),
      'the force-remote pull never staged the local edit into shared/',
    ).toBe(FORCED_MD);
  });
});

describe.skipIf(!hasGit || !hasGitleaks)(
  'parity: sync publishes an unpublished shared-config edit',
  () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'nomad-parity-sync-'));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("lands host B's edit on host A on both modalities", () => {
      // Sync runs the pull and the push under one held lock. Before the fix the
      // win32 pull half reverted the edit and the push half published the
      // revert, so the run made to publish the edit is what erased it.
      const { makeHost } = makeWorld(tmp);

      const a = makeHost('host-a');
      mkdirSync(a.claudeHome, { recursive: true });
      writeFileSync(join(a.claudeHome, 'CLAUDE.md'), ORIGINAL_MD);
      const initResult = runNomad(a, ['init', '--snapshot', '--keep-actions']);
      expect(initResult.status, `init failed:\n${initResult.stderr}`).toBe(0);
      g(['add', '-A'], a.repo);
      g(['commit', '-q', '-m', 'nomad init scaffold'], a.repo);
      g(['push', '-q', 'origin', 'main'], a.repo);

      const b = makeHost('host-b');
      const firstPull = runNomad(b, ['pull']);
      expect(firstPull.status, `host B first pull failed:\n${firstPull.stderr}`).toBe(0);
      const bClaudeMd = join(b.claudeHome, 'CLAUDE.md');
      expect(readFileSync(bClaudeMd, 'utf8'), 'shared config did not materialize on B').toBe(
        ORIGINAL_MD,
      );

      // The user edits their config and publishes it in one step.
      writeFileSync(bClaudeMd, SYNCED_MD);
      const sync = runNomad(b, ['sync']);
      expect(sync.status, `sync failed:\n${sync.stdout}\n${sync.stderr}`).toBe(0);

      // Invariant 1: sync's own pull half did not revert the edit under B.
      expect(readFileSync(bClaudeMd, 'utf8'), 'the sync pull half reverted the local edit').toBe(
        SYNCED_MD,
      );

      // Invariant 2: the push half published the EDIT, not the pre-edit content
      // the pull half would have restored. Asserted on B's repo first so a red
      // run separates a publish failure here from a receive failure on A, which
      // a single end-to-end assertion cannot tell apart.
      expect(
        readFileSync(join(b.repo, 'shared', 'CLAUDE.md'), 'utf8'),
        'the sync push half published what its own pull half restored, not the edit',
      ).toBe(SYNCED_MD);

      // Invariant 3: and the other host actually receives it. The second pull
      // is what buys receive-side coverage on win32, where the shared name is a
      // real copy rather than a symlink.
      const aPull = runNomad(a, ['pull']);
      expect(aPull.status, `host A pull failed:\n${aPull.stderr}`).toBe(0);
      expect(
        readFileSync(join(a.claudeHome, 'CLAUDE.md'), 'utf8'),
        "host A did not receive host B's published edit",
      ).toBe(SYNCED_MD);
    });
  },
);

// ---------------------------------------------------------------------------
// In-process sandbox
// ---------------------------------------------------------------------------

/** Env captured before a sandbox test plus the sandbox paths it operates on. */
type Sandbox = {
  /** `process.env.HOME` as it was before the sandbox replaced it. */
  originalHome: string | undefined;
  /** `process.env.NOMAD_HOST` as it was before the sandbox replaced it. */
  originalNomadHost: string | undefined;
  /** `process.env.NOMAD_REPO` as it was before the sandbox replaced it. */
  originalNomadRepo: string | undefined;
  /** Absolute path to the temp HOME. */
  testHome: string;
  /** Absolute path to the sandbox nomad repo (`NOMAD_REPO`). */
  repoHome: string;
  /** Absolute path to `<testHome>/.claude`. */
  claudeHome: string;
  /** Absolute path to `<repoHome>/shared`. */
  sharedDir: string;
};

/**
 * Create an isolated HOME sandbox for an in-process parity test: a temp HOME
 * with a `git init`'d nomad repo, a `shared/` tree, and a `.claude/` host root,
 * with `HOME`, `NOMAD_HOST`, and `NOMAD_REPO` pointed at it. Resets the module
 * cache so `config.ts` re-reads the env on the next dynamic import.
 *
 * The repo is a real git repo because `cmdAdopt` ends in a targeted `git add`,
 * which needs an index to mutate.
 *
 * @returns The captured env and the sandbox paths.
 */
function makeSandbox(): Sandbox {
  const originalHome = process.env.HOME;
  const originalNomadHost = process.env.NOMAD_HOST;
  const originalNomadRepo = process.env.NOMAD_REPO;

  const testHome = mkdtempSync(join(tmpdir(), 'nomad-parity-'));
  const repoHome = join(testHome, 'claude-nomad');
  const claudeHome = join(testHome, '.claude');
  const sharedDir = join(repoHome, 'shared');
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoHome });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoHome });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoHome });

  process.env.HOME = testHome;
  process.env.NOMAD_HOST = 'test-host';
  process.env.NOMAD_REPO = repoHome;
  process.exitCode = 0;
  vi.resetModules();

  return {
    originalHome,
    originalNomadHost,
    originalNomadRepo,
    testHome,
    repoHome,
    claudeHome,
    sharedDir,
  };
}

/**
 * Restore one env key to the value captured by {@link makeSandbox}, deleting it
 * when it was unset.
 *
 * @param key - Environment variable name.
 * @param value - Captured prior value, or `undefined` when it was unset.
 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value !== undefined) process.env[key] = value;
  else delete process.env[key];
}

/**
 * Undo {@link makeSandbox}: restore the captured env, clear any exit code a
 * doctor reporter set, then remove the temp HOME.
 *
 * @param sandbox - The sandbox returned by {@link makeSandbox}.
 */
function restoreSandbox(sandbox: Sandbox): void {
  restoreEnv('HOME', sandbox.originalHome);
  restoreEnv('NOMAD_HOST', sandbox.originalNomadHost);
  restoreEnv('NOMAD_REPO', sandbox.originalNomadRepo);
  process.exitCode = 0;
  rmSync(sandbox.testHome, { recursive: true, force: true });
}

/**
 * Seed one `SHARED_LINKS` name under `shared/` with recognizable content. Names
 * carrying a file extension are seeded as files, the rest as directories with a
 * single member, matching the real shape of the shared set.
 *
 * @param sharedDir - Absolute path to the repo's `shared/` directory.
 * @param name - The shared name to seed.
 * @returns The absolute path whose content the assertions read back, and that content.
 */
function seedShared(sharedDir: string, name: string): { probe: string; content: string } {
  const content = `# shared ${name}\n`;
  if (name.includes('.')) {
    const probe = join(sharedDir, name);
    writeFileSync(probe, content);
    return { probe: name, content };
  }
  mkdirSync(join(sharedDir, name), { recursive: true });
  writeFileSync(join(sharedDir, name, 'member.md'), content);
  return { probe: join(name, 'member.md'), content };
}

describe.skipIf(!hasGit)('parity: shared config materializes and reads back', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreSandbox(sandbox);
  });

  it('makes every shared name readable under ~/.claude after applySharedLinks', async () => {
    const seeded = SHARED_LINKS.map((name) => seedShared(sandbox.sharedDir, name));

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260730-000000', { projects: {} });

    for (const { probe, content } of seeded) {
      expect(
        readFileSync(join(sandbox.claudeHome, probe), 'utf8'),
        `${probe} did not resolve`,
      ).toBe(content);
    }
  });

  it('reports no FAIL for the shared links a clean apply just materialized', async () => {
    for (const name of SHARED_LINKS) seedShared(sandbox.sharedDir, name);

    const { applySharedLinks } = await import('./links.ts');
    applySharedLinks('20260730-000001', { projects: {} });

    // "Healthy" is inverted between the modalities: a real non-symlink entry is
    // a FAIL on posix and the correct state on win32. One unstubbed assertion
    // covers both definitions because the doctor check reads the same real
    // process.platform the apply above did.
    const { reportSharedLinks } = await import('./commands.doctor.checks.repo.ts');
    const sec = section('Links');
    reportSharedLinks(sec, { projects: {} });

    expect(sec.items.length, 'doctor emitted no shared-link rows to judge').toBe(
      SHARED_LINKS.length,
    );
    for (const row of sec.items) expect(row).not.toContain(failGlyph);
    expect(process.exitCode, 'a healthy shared set set a non-zero exit code').toBe(0);
  });
});

describe.skipIf(!hasGit)('parity: adopt then eject round-trip', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreSandbox(sandbox);
  });

  it('adopts a host file into shared/ and ejects it back to a real local copy', async () => {
    const localPath = join(sandbox.claudeHome, 'CLAUDE.md');
    writeFileSync(localPath, ORIGINAL_MD);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { cmdAdopt } = await import('./commands.adopt.ts');
    cmdAdopt('CLAUDE.md');
    expect(exitSpy, 'adopt bailed out').not.toHaveBeenCalled();

    // Adopt moves the file into the repo and leaves the host a working
    // counterpart: a symlink on posix, a real copy on win32. Both read back
    // the same bytes, which is the only thing a user cares about.
    expect(readFileSync(join(sandbox.sharedDir, 'CLAUDE.md'), 'utf8')).toBe(ORIGINAL_MD);
    expect(readFileSync(localPath, 'utf8'), 'adopt left no usable local counterpart').toBe(
      ORIGINAL_MD,
    );

    // Eject is the offboarding contract: whatever the modality was, the host
    // ends up owning a real, standalone file that survives deleting the repo.
    const { cmdEject } = await import('./commands.eject.ts');
    cmdEject({}, { claudeHome: sandbox.claudeHome, repoHome: sandbox.repoHome });
    expect(exitSpy, 'eject bailed out').not.toHaveBeenCalled();

    expect(lstatSync(localPath).isSymbolicLink(), 'eject left a symlink behind').toBe(false);
    expect(readFileSync(localPath, 'utf8'), 'eject lost the shared content').toBe(ORIGINAL_MD);
  });
});

/**
 * Recursively snapshot `{ relativePath: content }` for every regular file
 * under `root`, POSIX-separated so the map is comparable regardless of which
 * OS produced the paths. Used to derive the set of names the wet mirror pass
 * actually wrote, by diffing a before/after pair.
 */
function snapshotFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        out.set(relative(root, abs).split(sep).join('/'), readFileSync(abs, 'utf8'));
      } catch {
        /* vanished between the directory read and the file read */
      }
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!hasGit)(
  'parity: the mirror dry-run preview agrees with what the wet pass writes',
  () => {
    let sandbox: Sandbox;

    beforeEach(() => {
      sandbox = makeSandbox();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      restoreSandbox(sandbox);
    });

    it('the dry-run name set equals the set of names the wet pass actually wrote to disk', async () => {
      // A capturable shared name: a repo-side counterpart exists, and the host
      // copy carries an unpublished edit. On posix this proves the trivial
      // case (both sides empty, the mirror is a no-op); on the windows-latest
      // CI leg the real copy-sync branch runs, which is the point of this
      // file: nothing here stubs process.platform.
      seedShared(sandbox.sharedDir, 'CLAUDE.md');
      writeFileSync(join(sandbox.claudeHome, 'CLAUDE.md'), '# host edit, not yet pushed\n');

      const { stageLocalSharedEdits } = await import('./links.mirror.ts');
      const before = snapshotFiles(sandbox.sharedDir);

      const dryEvents: { name: string }[] = [];
      stageLocalSharedEdits({ projects: {} }, '20260810-040000', {
        dryRun: true,
        onPreview: (e) => dryEvents.push(e),
      });
      const dryNames = new Set(dryEvents.map((e) => e.name));
      // The final equality holds because every seeded name carries a real host
      // edit. The mirror emits one dry-run event per name that passes its
      // gates, not per name whose bytes change, so seeding a name whose host
      // copy already matches the repo copy would add an event with no wet-pass
      // delta behind it and fail the comparison as a fixture artifact.
      // dryRun must not have written anything, so the wet pass below is the
      // only source of the "actually wrote" side of the comparison.
      expect(snapshotFiles(sandbox.sharedDir)).toEqual(before);

      stageLocalSharedEdits({ projects: {} }, '20260810-040000');
      const after = snapshotFiles(sandbox.sharedDir);
      const wetWrittenNames = new Set<string>();
      for (const [relPath, content] of after) {
        if (before.get(relPath) !== content) wetWrittenNames.add(relPath.split('/')[0]);
      }
      for (const relPath of before.keys()) {
        if (!after.has(relPath)) wetWrittenNames.add(relPath.split('/')[0]);
      }

      expect([...dryNames].sort()).toEqual([...wetWrittenNames].sort());
    });
  },
);
