import { repoHome } from './config.ts';
import { gitProbe } from './git-probe.ts';

/** ssh keepalives: a dead connection makes ssh, and so git, exit after about a minute. */
export const SSH_KEEPALIVE_COMMAND = 'ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4';

/**
 * Make git children abort a stalled transfer themselves (HTTPS below 1000 B/s for 60 s,
 * ssh keepalives). Leaves any value or ssh command the user already set.
 * @param env - Environment to fill in; `process.env` by default.
 */
export function installGitStallBounds(env: NodeJS.ProcessEnv = process.env): void {
  env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1000';
  env.GIT_HTTP_LOW_SPEED_TIME ??= '60';
  if (env.GIT_SSH_COMMAND !== undefined || env.GIT_SSH !== undefined) return;
  const configured = gitProbe(['config', '--get', 'core.sshCommand'], repoHome());
  if (configured === null) env.GIT_SSH_COMMAND = SSH_KEEPALIVE_COMMAND;
}
