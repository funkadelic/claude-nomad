#!/usr/bin/env -S npx tsx
/**
 * claude-nomad: Claude Code config sync wrapper over a private Git repo.
 *
 * Adds two features the existing community tools lack:
 *   1. Path remapping so session history follows you across machines even
 *      when the same repo lives at /Users/norm/code/foo vs /home/norm/foo.
 *   2. Per-host overrides for settings.json via deep merge.
 *
 * Layout (~/claude-nomad/):
 *   shared/                  symlinked into ~/.claude/ on every host
 *   shared/settings.base.json  merged with hosts/<hostname>.json -> settings.json
 *   shared/projects/         session transcripts keyed by logical name
 *   hosts/<hostname>.json    per-host settings.json overrides
 *   path-map.json            logical project name -> { host: localPath }
 */

import { cmdDoctor, cmdPull, cmdPush, resumeCmd } from './commands.ts';

const cmd = process.argv[2];
switch (cmd) {
  case 'pull':
    cmdPull();
    break;
  case 'push':
    cmdPush();
    break;
  case 'doctor':
    // D-11 sub-flag: `doctor --resume-cmd <session-id>` dispatches to the
    // read-only sidecar that prints `cd <abspath> && claude --resume <id>`.
    if (process.argv[3] === '--resume-cmd') {
      const id = process.argv[4];
      if (typeof id !== 'string' || id.length === 0) {
        console.error('usage: nomad doctor --resume-cmd <session-id>');
        process.exit(1);
      }
      resumeCmd(id);
    } else {
      cmdDoctor();
    }
    break;
  default:
    console.error('usage: nomad <pull|push|doctor [--resume-cmd <id>]>');
    process.exit(1);
}
