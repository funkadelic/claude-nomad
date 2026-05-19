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

import { cmdDoctor } from './commands.doctor.ts';
import { cmdPull } from './commands.pull.ts';
import { cmdPush } from './commands.push.ts';
import { HOME } from './config.ts';
import { cmdInit } from './init.ts';
import { resumeCmd } from './resume.ts';
import { NomadFatal } from './utils.ts';

if (!HOME) {
  console.error(
    '[nomad] FATAL: could not determine home directory (HOME env unset and no uid mapping). Set HOME and retry.',
  );
  process.exit(1);
}

try {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'pull':
      cmdPull();
      break;
    case 'push':
      cmdPush();
      break;
    case 'init':
      // Slice A only adds plain `nomad init` (empty-scaffold mode). The
      // `--snapshot` variant arrives in Slice B. Reject any extra argv with
      // the same usage-error pattern as `doctor --resume-cmd`'s validation.
      if (process.argv.length > 3) {
        console.error('usage: nomad init');
        process.exit(1);
      }
      cmdInit();
      break;
    case 'doctor':
      // Sub-flag: `doctor --resume-cmd <session-id>` dispatches to the
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
      console.error('usage: nomad <pull|push|doctor [--resume-cmd <id>] | init>');
      process.exit(1);
  }
} catch (err) {
  // Top-level safety net for NomadFatal thrown from contexts that don't have
  // their own try/catch (e.g., cmdDoctor's readJson path). cmdPull / cmdPush
  // have their own catches so their finally blocks release the lock first.
  if (err instanceof NomadFatal) {
    console.error(`[nomad] FATAL: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
