import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
