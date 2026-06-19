import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodePath } from '../utils.json.ts';

/**
 * Run a git command in `cwd`. Throws on non-zero exit.
 *
 * @param args - Git subcommand and arguments as an argv array.
 * @param cwd - Working directory for the command.
 */
export function g(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Capture stdout of a git command in `cwd`. Throws on non-zero exit.
 *
 * @param args - Git subcommand and arguments as an argv array.
 * @param cwd - Working directory for the command.
 * @returns Trimmed stdout string.
 */
export function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
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
  g(['config', 'user.email', 'test@example.invalid'], cwd);
  g(['config', 'user.name', 'test'], cwd);
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
  g(['config', 'user.email', 'test@example.invalid'], local);
  g(['config', 'user.name', 'test'], local);

  return { local, origin, projectRoot };
}

/**
 * Plant a local session transcript under
 * `<home>/.claude/projects/<encoded projectRoot>/<sid>.jsonl` so `remapPush`
 * copies it into `shared/projects/<logical>/` on push.
 *
 * @param home - Resolved HOME for this invocation.
 * @param projectRoot - Host project root the session belongs to.
 * @param content - Transcript file content.
 * @returns The session id of the planted transcript.
 */
export function plantLocalSession(home: string, projectRoot: string, content: string): string {
  const sid = 'sid-e2e-001';
  const dir = join(home, '.claude', 'projects', encodePath(projectRoot));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), content);
  return sid;
}
