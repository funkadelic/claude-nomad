import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { g, gitInit, makeBareOrigin, setTestIdentity } from './git.ts';

/**
 * All state needed to drive a single synthetic nomad host. The `env` object is
 * passed directly to `runNomad` so each subprocess sees its own `HOME`,
 * `NOMAD_REPO`, and `NOMAD_HOST` without touching the parent process env.
 * `claudeHome` is a local convenience for the test's own path assertions; nomad
 * itself derives `~/.claude` from `HOME` at call time and does not read a
 * `CLAUDE_HOME` env variable.
 */
export type Host = {
  /** Absolute path to the host's synthetic HOME directory. */
  home: string;
  /** Absolute path to `<home>/.claude` (local convenience for test assertions). */
  claudeHome: string;
  /** Absolute path to the host's clone of the shared bare origin (NOMAD_REPO). */
  repo: string;
  /** Lowercased hostname passed as `NOMAD_HOST`. */
  hostname: string;
  /** Complete env object for subprocess invocations; overrides HOME, NOMAD_REPO, NOMAD_HOST. */
  env: NodeJS.ProcessEnv;
};

/**
 * Build a two-host world rooted under `tmp`. Creates one shared bare origin and
 * returns a `makeHost(name)` factory that mints synthetic hosts: each host gets
 * its own `HOME` subdirectory and its own `git clone` of the shared origin as
 * `NOMAD_REPO`, wired with the test git identity.
 *
 * Passing `NOMAD_HOST` per-host is what differentiates host A from host B inside
 * the nomad subprocess; `config.ts` reads `NOMAD_HOST` at module scope so fresh
 * subprocess env is required (which `runNomad` provides). Do NOT set
 * `CLAUDE_HOME`: `claudeHome()` in `config.ts` is `resolve(home(), '.claude')`,
 * so redirecting `HOME` is sufficient and the dead `CLAUDE_HOME` wire would only
 * cause confusion.
 *
 * @param tmp - Root temp directory (created by the caller; all output stays under it).
 * @returns Object with the bare `origin` path and a `makeHost(name)` factory.
 */
export function makeWorld(tmp: string): {
  origin: string;
  makeHost: (name: string) => Host;
} {
  const origin = makeBareOrigin(tmp);

  // Seed the bare origin with an initial empty commit so `main` exists before
  // any host clones it. Without this, `git pull --rebase` inside `nomad push`
  // fails with "no such ref" because origin has no branches to track.
  const seed = join(tmp, '.world-seed');
  mkdirSync(seed, { recursive: true });
  gitInit(seed);
  writeFileSync(join(seed, '.gitkeep'), '');
  g(['add', '.'], seed);
  g(['commit', '-q', '-m', 'seed'], seed);
  g(['remote', 'add', 'origin', origin], seed);
  g(['push', '-q', 'origin', 'main'], seed);

  function makeHost(name: string): Host {
    const home = join(tmp, name);
    const claudeHome = join(home, '.claude');
    const repo = join(tmp, `${name}-repo`);
    const hostname = name.toLowerCase();

    mkdirSync(home, { recursive: true });
    g(['clone', '-q', origin, repo], tmp);
    setTestIdentity(repo);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      NOMAD_REPO: repo,
      NOMAD_HOST: hostname,
      // Neutralize the real global/system gitconfig for the spawned nomad's own
      // git calls (push/pull), so a host-level commit.gpgsign or core.hooksPath
      // cannot break or hang the journey.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };

    return { home, claudeHome, repo, hostname, env };
  }

  return { origin, makeHost };
}

/**
 * Spawn the real nomad dev entrypoint (`node src/nomad.ts`) as a subprocess
 * with the given host's environment. This is the integration-test subprocess
 * driver: argv parsing, command dispatch, and process exit codes are all
 * exercised in the child process, so nothing runs in-process.
 *
 * The entry path is resolved relative to THIS file (`src/test-support/world.ts`)
 * so `../nomad.ts` always points at `src/nomad.ts` independent of the process
 * working directory.
 *
 * `--disable-warning=ExperimentalWarning` suppresses the TypeScript type-strip
 * banner that Node emits to stderr, keeping stderr clean for assertion purposes.
 *
 * @param host - Host whose env is forwarded to the subprocess.
 * @param args - nomad subcommand and flags (e.g. `['push']`, `['init', '--snapshot']`).
 * @returns `{ status, stdout, stderr }` from the subprocess.
 */
export function runNomad(
  host: Host,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const entry = fileURLToPath(new URL('../nomad.ts', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', entry, ...args],
    { encoding: 'utf8', env: host.env },
  );
  // A null status means the child never exited normally (signal-killed or it
  // failed to spawn), which is distinct from a clean non-zero exit. Surface it
  // loudly rather than masquerading as exit(1). The journey never triggers this.
  /* c8 ignore start */
  if (result.status === null) {
    throw new Error(
      `nomad subprocess did not exit normally: signal=${result.signal ?? 'none'}` +
        (result.error ? `, error=${result.error.message}` : ''),
    );
  }
  /* c8 ignore stop */
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
