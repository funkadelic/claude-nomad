import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deepMerge, encodePath } from './utils.json.ts';
import { g, gitOut, plantLocalSession } from './test-support/git.ts';
import { makeWorld, runNomad } from './test-support/world.ts';

/**
 * Returns `true` when the `git` binary is present on PATH. Used to gate the
 * whole round-trip describe so a host without git skips cleanly instead of
 * failing with an unhelpful spawn error.
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
 * Returns `true` when the `gitleaks` binary is present on PATH. The push leg of
 * the round-trip runs the real `nomad push` pipeline, which hard-requires
 * gitleaks. CI test jobs install it, but the npm-publish prepublishOnly hook
 * runs the same suite without it, so gate the describe to skip cleanly there
 * instead of failing the release.
 */
const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit || !hasGitleaks)(
  'two-host round-trip (init -> push on A, pull on B)',
  () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'nomad-roundtrip-'));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('syncs symlinks, settings merge, a session transcript, the .claude extra, and skills from A to B', () => {
      // Create the shared origin first; host B is cloned AFTER host A pushes so
      // B's clone is not stale and nomad pull can see shared/settings.base.json.
      const { makeHost } = makeWorld(tmp);
      const a = makeHost('host-a');

      // Seed host A's ~/.claude with the SHARED_LINK targets that init --snapshot
      // will capture, plus a settings.json precursor that will become both
      // shared/settings.base.json and hosts/host-a.json.
      mkdirSync(a.claudeHome, { recursive: true });
      writeFileSync(join(a.claudeHome, 'CLAUDE.md'), '# shared claude md\n');
      mkdirSync(join(a.claudeHome, 'commands'), { recursive: true });
      writeFileSync(join(a.claudeHome, 'commands', 'hello.md'), '# hello command\n');

      // Seed a user skill plus a gsd-prefixed skill BEFORE init: init --snapshot
      // does not touch skills (they are copy-synced, not a SHARED_LINK), so this
      // is safe and lets syncSkillsPush/syncSkillsPull carry both through the
      // same push/pull legs as everything else.
      mkdirSync(join(a.claudeHome, 'skills', 'my-skill'), { recursive: true });
      const skillContent = '# my skill (from A)\n';
      writeFileSync(join(a.claudeHome, 'skills', 'my-skill', 'SKILL.md'), skillContent);
      mkdirSync(join(a.claudeHome, 'skills', 'gsd-something'), { recursive: true });
      writeFileSync(join(a.claudeHome, 'skills', 'gsd-something', 'SKILL.md'), '# gsd skill\n');

      // Extend the seeded settings with a nested array key (permissions.allow) so
      // the eventual hosts/host-b.json override below exercises array-replace
      // merge semantics, not just the scalar theme/fontSize keys.
      const seedSettings: Record<string, unknown> = {
        theme: 'dark',
        fontSize: 14,
        permissions: { allow: ['Bash(git:*)', 'Read'] },
      };
      writeFileSync(join(a.claudeHome, 'settings.json'), JSON.stringify(seedSettings) + '\n');

      // Plant a session transcript on A under a project root that lives under tmp.
      const projectRoot = join(tmp, 'myproject');
      mkdirSync(projectRoot, { recursive: true });
      const sessionContent = '{"role":"user","text":"hello from A"}\n';
      const sid = plantLocalSession(a.home, projectRoot, sessionContent);

      // Host A: init with --snapshot to capture the seeded ~/.claude content.
      // --keep-actions prevents the gh-actions disable flow from running in CI.
      const initResult = runNomad(a, ['init', '--snapshot', '--keep-actions']);
      expect(initResult.status, `init failed:\n${initResult.stderr}`).toBe(0);

      // Non-empty host-override payload: hosts/host-b.json with a scalar override
      // (theme) and an array key holding different members than the base
      // (permissions.allow), so the merge oracle below exercises a real override
      // instead of merging against an empty {}. init already scaffolded hosts/
      // via hosts/host-a.json; mkdir defensively in case that ever changes.
      mkdirSync(join(a.repo, 'hosts'), { recursive: true });
      writeFileSync(
        join(a.repo, 'hosts', 'host-b.json'),
        JSON.stringify({ theme: 'light', permissions: { allow: ['Read'] } }) + '\n',
      );

      // Commit the scaffold written by init so the files are tracked in origin
      // before push runs. A human user does this after reviewing the scaffold
      // (nomad init writes files but does not auto-commit). Committing here lets
      // nomad push see only the subsequent path-map and session changes as new
      // status lines, keeping them within the push allow-list.
      g(['add', '-A'], a.repo);
      g(['commit', '-q', '-m', 'nomad init scaffold'], a.repo);
      g(['push', '-q', 'origin', 'main'], a.repo);

      // Assert init --snapshot actually scaffolded the settings split, so a
      // regression in what init writes fails here rather than only surfacing
      // downstream as a confusing settings or symlink mismatch on B.
      const scaffolded = gitOut(['show', '--name-only', '--format=', 'HEAD'], a.repo);
      expect(scaffolded, 'init scaffold missing settings.base.json').toContain(
        'shared/settings.base.json',
      );
      expect(scaffolded, 'init scaffold missing hosts/host-a.json').toContain('hosts/host-a.json');

      // Update A's path-map.json to map the logical project under BOTH hosts so
      // remapPush (on A) and remapPull (on B) both resolve the transcript.
      // B's project path is distinct from A's so encodePath produces a different key.
      const bProjectRoot = join(tmp, 'host-b', 'myproject');
      mkdirSync(bProjectRoot, { recursive: true });
      const pathMapPath = join(a.repo, 'path-map.json');
      const pathMap = {
        projects: {
          myproject: {
            'host-a': projectRoot,
            'host-b': bProjectRoot,
          },
        },
        extras: {
          myproject: ['.claude'],
        },
      };
      writeFileSync(pathMapPath, JSON.stringify(pathMap) + '\n');

      // .claude extra deny-set payload on A: a syncable agent file (agents/ is
      // not in CLAUDE_EXTRA_NEVER_SYNC) plus a host-local settings.local.json
      // (deny-set) that must never leave host A.
      const aClaudeExtra = join(projectRoot, '.claude');
      mkdirSync(join(aClaudeExtra, 'agents'), { recursive: true });
      const agentContent = '# my agent (from A)\n';
      writeFileSync(join(aClaudeExtra, 'agents', 'my-agent.md'), agentContent);
      writeFileSync(join(aClaudeExtra, 'settings.local.json'), '{"host":"host-a"}\n');

      // Host A: push the session transcript and updated path-map to the shared origin.
      const pushResult = runNomad(a, ['push']);
      expect(pushResult.status, `push failed:\n${pushResult.stderr}`).toBe(0);

      // Mint host B AFTER the push so its clone of origin already contains the
      // scaffolded repo (shared/settings.base.json, path-map.json, and the
      // pushed session transcript). This mirrors a second user doing
      // `git clone <origin> ~/claude-nomad` then `nomad pull`.
      const b = makeHost('host-b');

      // Pre-plant B's own pre-existing host-local settings.local.json before the
      // pull. This is the 0.47.1 mirror-wipe regression guard: the pull must
      // preserve this file untouched rather than overwrite or delete it.
      const bClaudeExtra = join(bProjectRoot, '.claude');
      mkdirSync(bClaudeExtra, { recursive: true });
      const bLocalSettingsContent = '{"host":"host-b"}\n';
      writeFileSync(join(bClaudeExtra, 'settings.local.json'), bLocalSettingsContent);

      // Host B: pull from the shared origin.
      const pullResult = runNomad(b, ['pull']);
      expect(pullResult.status, `pull failed:\n${pullResult.stderr}`).toBe(0);

      // Assertion 1: SHARED_LINKS resolve on B. Only assert the names that
      // were seeded on A (CLAUDE.md and commands/). rules/ and
      // my-statusline.cjs were not seeded so they have no shared/ target;
      // applySharedLinks skips a link when shared/<name> does not exist.
      // On win32 (no unprivileged symlink support), the same names land as
      // real copies via the copy-sync branch instead of symlinks; both are
      // the platform's own definition of "resolved" here.
      const seededLinks = ['CLAUDE.md', 'commands'] as const;
      const isWin = process.platform === 'win32';
      for (const name of seededLinks) {
        const linkPath = join(b.claudeHome, name);
        expect(existsSync(linkPath), `${name} target does not exist on B`).toBe(true);
        expect(lstatSync(linkPath).isSymbolicLink(), `${name} symlink state on B`).toBe(!isWin);
      }
      // Verify the seeded content is visible through the symlink on B.
      const bClaudeMd = readFileSync(join(b.claudeHome, 'CLAUDE.md'), 'utf8');
      expect(bClaudeMd).toBe('# shared claude md\n');

      // Assertion 2: B's settings.json equals deepMerge(base, hosts/host-b.json).
      // The snapshot wrote the seeded settings.json into hosts/host-a.json;
      // hosts/host-b.json was written and pushed separately above so the
      // pull-side merge exercises a real, non-empty override.
      // Compute the oracle by reading the repo files on B's clone.
      const bRepoBase = join(b.repo, 'shared', 'settings.base.json');
      const bRepoHostJson = join(b.repo, 'hosts', 'host-b.json');
      const base = JSON.parse(readFileSync(bRepoBase, 'utf8')) as Record<string, unknown>;
      const hostOverrides = existsSync(bRepoHostJson)
        ? (JSON.parse(readFileSync(bRepoHostJson, 'utf8')) as Record<string, unknown>)
        : {};
      const expectedSettings = deepMerge(base, hostOverrides);
      const actualSettings = JSON.parse(
        readFileSync(join(b.claudeHome, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(actualSettings).toEqual(expectedSettings);
      // Assertion 5 (non-empty host override merge): exact-literal expectations
      // on the overridden keys, in addition to the oracle comparison above, so a
      // deepMerge regression that also breaks the oracle (computed with the same
      // function) cannot hide behind it.
      expect(actualSettings.theme, 'scalar override did not win').toBe('light');
      expect(
        (actualSettings.permissions as { allow: string[] }).allow,
        'array key was concatenated instead of replaced',
      ).toEqual(['Read']);

      // Assertion 3: the transcript appears under B's encodePath project dir.
      // The path-map maps 'myproject' to B's distinct bProjectRoot so remapPull
      // on B writes to ~/.claude/projects/<encodePath(bProjectRoot)>/<sid>.jsonl.
      const bEncodedDir = encodePath(bProjectRoot);
      const bSessionPath = join(b.claudeHome, 'projects', bEncodedDir, `${sid}.jsonl`);
      expect(existsSync(bSessionPath), `session not found at ${bSessionPath}`).toBe(true);
      expect(readFileSync(bSessionPath, 'utf8')).toBe(sessionContent);

      // Assertion 4: the .claude extra round-trips with deny-set preservation.
      // Guards two boundaries at once: the push-side deny filter (A's
      // settings.local.json must never enter the repo) and the pull-side
      // preserving overlay (B's pre-existing settings.local.json must survive
      // the pull untouched, the 0.47.1 mirror-wipe regression).
      const bAgentPath = join(bProjectRoot, '.claude', 'agents', 'my-agent.md');
      expect(existsSync(bAgentPath), 'agent file not found on B').toBe(true);
      expect(readFileSync(bAgentPath, 'utf8')).toBe(agentContent);

      const bLocalSettingsPath = join(bProjectRoot, '.claude', 'settings.local.json');
      expect(
        readFileSync(bLocalSettingsPath, 'utf8'),
        "B's settings.local.json was overwritten by the pull",
      ).toBe(bLocalSettingsContent);

      const repoLeakedPath = join(
        b.repo,
        'shared',
        'extras',
        'myproject',
        '.claude',
        'settings.local.json',
      );
      expect(existsSync(repoLeakedPath), "A's settings.local.json leaked into the repo").toBe(
        false,
      );

      // Assertion 6: skills copy-sync mirrors the user skill as a real (non-
      // symlink) copy and excludes the gsd-prefixed skill from both the repo
      // and B.
      const bSkillPath = join(b.claudeHome, 'skills', 'my-skill', 'SKILL.md');
      expect(existsSync(bSkillPath), 'user skill not found on B').toBe(true);
      expect(
        lstatSync(bSkillPath).isSymbolicLink(),
        'user skill should be a real copy, not a symlink',
      ).toBe(false);
      expect(readFileSync(bSkillPath, 'utf8')).toBe(skillContent);

      expect(
        existsSync(join(b.claudeHome, 'skills', 'gsd-something')),
        'gsd-prefixed skill leaked to B',
      ).toBe(false);
      expect(
        existsSync(join(b.repo, 'shared', 'skills', 'gsd-something')),
        'gsd-prefixed skill leaked into the repo',
      ).toBe(false);
    });
  },
);
