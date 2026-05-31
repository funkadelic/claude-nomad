import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HOME, type PathMap, REPO_HOME } from './config.ts';
import {
  disableActions,
  ghAuthStatus,
  isActionsEnabled,
  isRepoPrivate,
  parseGitHubRemote,
  readOriginRemote,
  type SpawnSyncFn,
} from './gh-actions.ts';
import { DEFAULT_REPO_NAME, ensureOriginRepo } from './init.gh-onboard.ts';
import { snapshotIntoShared } from './init.snapshot.ts';
import { die, log } from './utils.ts';
import { writeJsonAtomic } from './utils.fs.ts';

/**
 * The HTML comment line that anchors `shared/CLAUDE.md` on a fresh scaffold.
 * Empty file would be silently misleading after symlinking into `~/.claude/`;
 * the comment makes the file self-describing when grep'd or `cat`-ed later.
 */
const SHARED_CLAUDE_MD =
  '<!-- claude-nomad shared CLAUDE.md; symlinked into ~/.claude/CLAUDE.md by nomad pull -->\n';

/**
 * Subdirectories under `shared/` that get a `.gitkeep` placeholder on a fresh
 * scaffold so the empty dirs survive git and materialize on every host. Pairs
 * with the SHARED_LINKS contract in `src/config.ts` (those same names are
 * symlinked into `~/.claude/` on every pull).
 */
const SHARED_KEEP_DIRS = ['agents', 'skills', 'commands', 'rules', 'hooks'] as const;

/**
 * Pre-flight refuse-to-clobber list. If ANY of these absolute paths
 * already exists at the target REPO_HOME, `cmdInit` aborts with a NomadFatal
 * naming the offender. Partial state is unsafe to merge with; init writes
 * only into a clean target. Note that REPO_HOME itself is allowed to exist
 * (e.g. it might be an empty dir created by `git clone` of an empty repo);
 * the guard fires only on artifacts cmdInit is about to write.
 */
function preflightConflict(repoHome: string): string | null {
  const candidates = [
    join(repoHome, 'shared', 'settings.base.json'),
    join(repoHome, 'shared', 'CLAUDE.md'),
    join(repoHome, 'path-map.json'),
    join(repoHome, 'hosts'),
    join(repoHome, 'shared'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Scaffold REPO_HOME with the minimal layout `cmdDoctor` expects: `shared/`
 * with `CLAUDE.md`, four `<name>/.gitkeep` markers, and an empty
 * `settings.base.json`; `hosts/.gitkeep`; root `path-map.json` =
 * `{"projects":{}}`. No auto-commit; no lock (no concurrent-mutator surface
 * on a fresh target).
 *
 * When no `origin` remote exists in REPO_HOME, a private GitHub repository is
 * created via `gh` and wired as `origin` before scaffolding (D-06/D-07). The
 * repo name defaults to {@link DEFAULT_REPO_NAME} but can be overridden with
 * `opts.repoName`. `gh` is a hard prerequisite on this path and its absence or
 * unauthenticated state results in a NomadFatal (D-08). When `origin` already
 * exists the step is a no-op (D-09 idempotency).
 *
 * When `opts.snapshot` is true, the user's current `~/.claude/` SHARED_LINKS
 * are overlaid onto `shared/` and `~/.claude/settings.json` (if present) is
 * translated into `hosts/<HOST>.json`. The placeholder `shared/CLAUDE.md`
 * write is skipped when `~/.claude/CLAUDE.md` exists so the snapshot captures
 * verbatim content; originals are NOT removed. Aborts with NomadFatal
 * (containing `already initialized`) when any scaffold path already exists,
 * identical to plain init; a bare `shared/` dir is enough to refuse since
 * partial state is unsafe to merge with.
 */
export function cmdInit(
  opts: { snapshot?: boolean; keepActions?: boolean; repoName?: string; run?: SpawnSyncFn } = {},
): void {
  const snapshot = opts.snapshot === true;
  const keepActions = opts.keepActions === true;

  // Create REPO_HOME, then refuse to clobber an already-initialized tree BEFORE
  // any onboarding side effects. ensureOriginRepo can create a GitHub repo and
  // wire a remote, so the conflict guard must run first: otherwise a re-init on
  // an already-scaffolded REPO_HOME that lacks an origin would create a stray
  // private repo and wire it, then abort with "already initialized".
  mkdirSync(REPO_HOME, { recursive: true });

  const conflict = preflightConflict(REPO_HOME);
  if (conflict !== null) {
    die(`already initialized; refusing to clobber ${conflict}`);
  }

  // Wire the backing GitHub repo. Idempotent when origin already exists (D-09).
  ensureOriginRepo(opts.repoName ?? DEFAULT_REPO_NAME, opts.run);

  // Create the directory structure first so the subsequent file writes have
  // a parent. `recursive: true` is a no-op when the dir already exists, but
  // the preflight guarantees it does not.
  mkdirSync(join(REPO_HOME, 'shared'), { recursive: true });
  mkdirSync(join(REPO_HOME, 'hosts'), { recursive: true });
  for (const name of SHARED_KEEP_DIRS) {
    mkdirSync(join(REPO_HOME, 'shared', name), { recursive: true });
  }

  // Per-artifact writes. Each emits a log line so the user sees the
  // structure being built. Atomic writes for JSON so a power loss mid-init
  // leaves either a clean fresh-clone state or the fully-written scaffold,
  // never a half-written JSON the next pull would die on. In snapshot mode,
  // skip the CLAUDE.md placeholder when a real source exists so the overlay
  // copies the user content verbatim instead of an overwrite-from-placeholder.
  const userClaudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
  if (!snapshot || !existsSync(userClaudeMd)) {
    writeFileSync(join(REPO_HOME, 'shared', 'CLAUDE.md'), SHARED_CLAUDE_MD);
    log('created shared/CLAUDE.md');
  }
  for (const name of SHARED_KEEP_DIRS) {
    writeFileSync(join(REPO_HOME, 'shared', name, '.gitkeep'), '');
    log(`created shared/${name}/.gitkeep`);
  }
  writeFileSync(join(REPO_HOME, 'hosts', '.gitkeep'), '');
  log('created hosts/.gitkeep');
  writeJsonAtomic(join(REPO_HOME, 'shared', 'settings.base.json'), {});
  log('created shared/settings.base.json');
  writeJsonAtomic(join(REPO_HOME, 'path-map.json'), { projects: {} } satisfies PathMap);
  log('created path-map.json');

  if (snapshot) {
    // In the init path, path-map.json was just written as `{ projects: {} }`
    // (preflight refuses a pre-existing one), so sharedDirs is empty by
    // construction. Pass the minimal map literal to satisfy the type.
    snapshotIntoShared({ projects: {} });
    log(`snapshot staged in shared/; review, then 'nomad push' to share with other hosts.`);
    log('~/.claude/ originals were NOT removed.');
  }

  if (!keepActions) {
    maybeDisableMirrorActions(REPO_HOME, opts.run);
  }

  log('init complete');
}

/**
 * Best-effort hook that disables GitHub Actions on the user's private mirror
 * after a fresh `nomad init`. The private mirror is a settings store, not a
 * CI target; leaving Actions enabled there causes the mirror-pushed workflows
 * (release-please, npm-publish, etc.) to fire on every `nomad push`, which is
 * pure noise.
 *
 * Silently no-ops when: the repo is not a git repo, the origin remote is not
 * GitHub, the origin is public (not a private mirror), `gh` CLI is missing,
 * or `gh` is not authed. Prints a tip on the last two so the user can finish
 * the step manually. Suppress entirely with `nomad init --keep-actions`.
 */
function maybeDisableMirrorActions(repoHome: string, run?: SpawnSyncFn): void {
  let remote: string;
  try {
    remote = readOriginRemote(repoHome, run);
  } catch {
    return;
  }
  const ref = parseGitHubRemote(remote);
  if (ref === null) return;

  const ghStatus = ghAuthStatus(run);
  if (ghStatus === 'gh-not-installed') {
    log(
      `tip: install gh CLI and run 'gh api -X PUT repos/${ref.owner}/${ref.repo}/actions/permissions -F enabled=false' to disable Actions on your private mirror.`,
    );
    return;
  }
  if (ghStatus === 'gh-not-authed') {
    log(
      `tip: run 'gh auth login' then 'gh api -X PUT repos/${ref.owner}/${ref.repo}/actions/permissions -F enabled=false' to disable Actions on your private mirror.`,
    );
    return;
  }
  // A gh-probe-error (auth-status timed out or hiccuped) is deliberately left to
  // fall through: auth state is unknown, so the privacy probe below tries
  // optimistically with its own catch + tip. This avoids the misleading
  // 'gh auth login' tip a transient failure used to trigger when the user may
  // in fact be authed (#124).

  let isPrivate: boolean;
  try {
    isPrivate = isRepoPrivate(ref, run);
  } catch {
    log(
      `could not determine privacy for ${ref.owner}/${ref.repo}; run 'gh api -X PUT repos/${ref.owner}/${ref.repo}/actions/permissions -F enabled=false' manually if it is private.`,
    );
    return;
  }
  if (!isPrivate) return;

  let alreadyDisabled = false;
  try {
    alreadyDisabled = !isActionsEnabled(ref, run);
  } catch {
    // Treat as enabled and attempt the disable; the API call itself is
    // idempotent so this is safe.
  }
  if (alreadyDisabled) {
    log(`actions already disabled on ${ref.owner}/${ref.repo}`);
    return;
  }

  try {
    disableActions(ref, run);
    log(`disabled GitHub Actions on private mirror ${ref.owner}/${ref.repo}`);
  } catch {
    log(
      `could not auto-disable Actions on ${ref.owner}/${ref.repo}; run 'gh api -X PUT repos/${ref.owner}/${ref.repo}/actions/permissions -F enabled=false' manually.`,
    );
  }
}
