import { repoHome } from './config.ts';
import { gitProbe } from './git-probe.ts';

/** Ends an ssh connect that stalls (30 s) and a dead session (keepalives, about a minute). */
export const SSH_STALL_COMMAND =
  'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';

/** Git config keys that mean the user already chose these settings; names as git prints them. */
const USER_KEYS = /^(core\.sshcommand|ssh\.variant|http\..*lowspeed(limit|time))$/;

/**
 * Make git children abort a stalled transfer themselves (HTTPS at 0 B/s for 120 s, ssh
 * connect timeout and keepalives). Leaves any env value or git config the user already set.
 * @param env - Environment to fill in; `process.env` by default.
 */
export function installGitStallBounds(env: NodeJS.ProcessEnv = process.env): void {
  const out = gitProbe(['config', '--get-regexp', USER_KEYS.source], repoHome()) ?? '';
  const set = new Set(out.split('\n').map((line) => line.split(' ')[0]));
  // Any http.lowSpeed* key, including a URL-scoped `http.<url>.lowSpeedLimit`.
  if (![...set].some((k) => k.startsWith('http.'))) {
    env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1';
    env.GIT_HTTP_LOW_SPEED_TIME ??= '120';
  }
  const userSsh = [env.GIT_SSH_COMMAND, env.GIT_SSH, env.GIT_SSH_VARIANT].some(
    (v) => v !== undefined,
  );
  if (userSsh || set.has('core.sshcommand') || set.has('ssh.variant')) return;
  env.GIT_SSH_COMMAND = SSH_STALL_COMMAND;
}
