import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { encodePath } from '../utils.json.ts';

/**
 * Hermetic environment for every harness git invocation. Neutralizes the real
 * global and system gitconfig (so a host with `commit.gpgsign=true` or a global
 * `core.hooksPath` cannot break or hang fixture setup) and disables interactive
 * prompts, while preserving `process.env` so PATH still resolves the git binary.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Run a git command in `cwd` under the hermetic git env. Throws on non-zero exit.
 *
 * @param args - Git subcommand and arguments as an argv array.
 * @param cwd - Working directory for the command.
 */
export function g(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Capture stdout of a git command in `cwd` under the hermetic git env. Throws on
 * non-zero exit.
 *
 * @param args - Git subcommand and arguments as an argv array.
 * @param cwd - Working directory for the command.
 * @returns Trimmed stdout string.
 */
export function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/** Canonical author email used by every harness git repo. */
const TEST_GIT_EMAIL = 'test@example.invalid';
/** Canonical author name used by every harness git repo. */
const TEST_GIT_NAME = 'test';

/**
 * Set the canonical test git identity (`test@example.invalid` / `test`) on the
 * repo at `cwd`. Centralizes the identity so a cloned repo (which does not pass
 * through `gitInit`) configures the same author as a freshly initialized one.
 *
 * @param cwd - An existing git repository (init'd or cloned).
 */
export function setTestIdentity(cwd: string): void {
  g(['config', 'user.email', TEST_GIT_EMAIL], cwd);
  g(['config', 'user.name', TEST_GIT_NAME], cwd);
}

/**
 * Initialize a git repo at `cwd` with the canonical test identity
 * (`test@example.invalid` / `test`). Centralizes the init-plus-identity
 * sequence used across fixtures so every helper starts from a consistent state.
 *
 * @param cwd - Directory to initialize. Must already exist.
 */
export function gitInit(cwd: string): void {
  g(['init', '-q', '-b', 'main'], cwd);
  setTestIdentity(cwd);
}

/**
 * Create a bare git origin under `<parent>/origin.git`, initialized on
 * branch `main`. Returns the absolute path of the bare repo.
 *
 * @param parent - Parent directory under which the bare repo is created.
 * @returns Absolute path to the bare origin repo.
 */
export function makeBareOrigin(parent: string): string {
  const origin = join(parent, 'origin.git');
  mkdirSync(origin, { recursive: true });
  g(['init', '-q', '-b', 'main', '--bare'], origin);
  return origin;
}

/**
 * Build a bare origin plus a local clone with `shared/settings.base.json` and
 * a `path-map.json` mapping logical `testproj` to a host project root, so
 * `cmdPush` preconditions and the allow-list pass.
 *
 * @param tmp - Parent temp directory.
 * @returns Paths: `local` (the synced repo clone), `origin` (bare), `projectRoot`.
 */
export function buildPushRepo(tmp: string): { local: string; origin: string; projectRoot: string } {
  const origin = makeBareOrigin(tmp);
  const local = join(tmp, 'local');
  const projectRoot = join(tmp, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'shared'), { recursive: true });
  gitInit(seed);
  writeFileSync(join(seed, 'shared', 'settings.base.json'), '{}\n');
  writeFileSync(
    join(seed, 'path-map.json'),
    JSON.stringify({ projects: { testproj: { 'test-host': projectRoot } } }) + '\n',
  );
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'base'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  g(['clone', '-q', origin, local], tmp);
  setTestIdentity(local);

  return { local, origin, projectRoot };
}

/**
 * Build a world that starts from a genuinely SYNCED shared-config state: a bare
 * origin, a clone of it whose `shared/commands/` holds two committed files, and
 * a host config directory holding real copies of those same two files (the win32
 * copy model, not symlinks).
 *
 * Starting synced rather than contrived is what makes a deletion scenario real:
 * the host has demonstrably received both files, so removing one locally is
 * unambiguously the user deleting it rather than a host that never had it.
 *
 * @param tmp - Parent temp directory; everything created stays under it.
 * @returns The host `home` and `claudeDir`, the `repo` clone and its
 *   `sharedDir`, and the bare `origin`.
 */
export function buildSyncedSharedWorld(tmp: string): {
  home: string;
  claudeDir: string;
  repo: string;
  sharedDir: string;
  origin: string;
} {
  const origin = makeBareOrigin(tmp);
  const repo = join(tmp, 'repo');
  const home = join(tmp, 'home');
  const claudeDir = join(home, '.claude');

  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'shared', 'commands'), { recursive: true });
  gitInit(seed);
  writeFileSync(join(seed, 'shared', 'settings.base.json'), '{}\n');
  writeFileSync(join(seed, 'shared', 'commands', 'keep.md'), '# keep\n');
  writeFileSync(join(seed, 'shared', 'commands', 'doomed.md'), '# doomed\n');
  writeFileSync(join(seed, 'path-map.json'), JSON.stringify({ projects: {} }) + '\n');
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'base'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  g(['clone', '-q', origin, repo], tmp);
  setTestIdentity(repo);

  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  writeFileSync(join(claudeDir, 'commands', 'keep.md'), '# keep\n');
  writeFileSync(join(claudeDir, 'commands', 'doomed.md'), '# doomed\n');

  return { home, claudeDir, repo, sharedDir: join(repo, 'shared'), origin };
}

/** Monotonic counter backing the unique session ids minted by {@link plantLocalSession}. */
let sessionSeq = 0;

/**
 * Plant a local session transcript under
 * `<home>/.claude/projects/<encoded projectRoot>/<sid>.jsonl` so `remapPush`
 * copies it into `shared/projects/<logical>/` on push. Each call mints a fresh
 * `sid` from a monotonic counter so planting two sessions never collides.
 *
 * The returned id is unique per process run, NOT stable per test: the counter is
 * module-scope and is never reset between tests or across importing files. Always
 * use the returned `sid` for assertions; never hardcode a literal like
 * `sid-e2e-001`, which would pass in isolation but break once another planting
 * test runs first.
 *
 * @param home - Resolved HOME for this invocation.
 * @param projectRoot - Host project root the session belongs to.
 * @param content - Transcript file content.
 * @returns The session id of the planted transcript (unique per process run).
 */
export function plantLocalSession(home: string, projectRoot: string, content: string): string {
  const sid = `sid-e2e-${String(++sessionSeq).padStart(3, '0')}`;
  const dir = join(home, '.claude', 'projects', encodePath(projectRoot));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), content);
  return sid;
}

/**
 * Create a commit in `repo` with `content` written to `file`.
 *
 * @param repo - Repository working directory.
 * @param file - Repo-relative path to write.
 * @param content - File contents.
 * @param message - Commit message.
 */
export function makeCommit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  g(['add', file], repo);
  g(['commit', '-q', '-m', message], repo);
}

/**
 * Start a conflicting merge in `dir`, then delete its marker files, leaving
 * the unmerged stage-2/3 index entries behind with no active merge. This is
 * the exact state a conflicted autostash pop leaves: `git diff
 * --diff-filter=U` still reports the paths, but `MERGE_HEAD` and the rebase
 * directories are all absent.
 *
 * Assumes `dir` is an initialized repo with at least one commit touching
 * `file.txt`.
 *
 * @param dir - Repository working directory.
 */
export function conflictThenStripMarkers(dir: string): void {
  g(['checkout', '-q', '-b', 'branch'], dir);
  makeCommit(dir, 'file.txt', 'branch-value\n', 'branch commit');
  g(['checkout', '-q', 'main'], dir);
  makeCommit(dir, 'file.txt', 'main-value\n', 'main commit');
  try {
    g(['merge', '--no-commit', 'branch'], dir);
  } catch {
    // Expected conflict: the merge is the whole point of this fixture.
  }
  const gitDir = join(dir, '.git');
  for (const marker of ['MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG']) {
    rmSync(join(gitDir, marker), { force: true });
  }
}

/**
 * Build a repo whose index has unmerged stage-2/3 entries and no active
 * rebase or merge marker, the torn-down state both the wedge classifier and
 * the autostash-pop guard are built to detect.
 *
 * @param dir - Directory to initialize. Must already exist.
 */
export function buildUnmergedIndexNoMarker(dir: string): void {
  gitInit(dir);
  makeCommit(dir, 'file.txt', 'base\n', 'base');
  conflictThenStripMarkers(dir);
}

/**
 * Leave an ALREADY-INITIALIZED repo in the same unmerged-index-no-marker state,
 * using a scratch file so nothing the caller cares about is touched. Use this to
 * wedge a repo built by another fixture, where `buildUnmergedIndexNoMarker`
 * would clobber the existing history.
 *
 * @param dir - An existing git repository with at least one commit.
 */
export function wedgeExistingRepo(dir: string): void {
  makeCommit(dir, 'file.txt', 'base\n', 'wedge base');
  conflictThenStripMarkers(dir);
}

/**
 * Publish a change to `origin` from a throwaway clone, so a host's next pull has
 * something real to rebase onto. Used to stage a genuine two-sided change where
 * upstream and the host touched the same file.
 *
 * @param origin - Bare origin repo to push to.
 * @param tmp - Parent temp directory for the throwaway clone.
 * @param relPath - Repo-relative path to write.
 * @param content - File contents.
 * @param message - Commit message.
 */
export function pushUpstreamChange(
  origin: string,
  tmp: string,
  relPath: string,
  content: string,
  message: string,
): void {
  const scratch = mkdtempSync(join(tmp, 'upstream-'));
  g(['clone', '-q', origin, scratch], tmp);
  setTestIdentity(scratch);
  mkdirSync(dirname(join(scratch, relPath)), { recursive: true });
  writeFileSync(join(scratch, relPath), content);
  g(['add', relPath], scratch);
  g(['commit', '-q', '-m', message], scratch);
  g(['push', '-q', 'origin', 'main'], scratch);
  rmSync(scratch, { recursive: true, force: true });
}
