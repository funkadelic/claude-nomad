#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
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

import { cmdAdopt } from './commands.adopt.ts';
import { cmdDoctor } from './commands.doctor.ts';
import { cmdDropSession } from './commands.drop-session.ts';
import { cmdRedact } from './commands.redact.ts';
import { cmdPull } from './commands.pull.ts';
import { cmdPush } from './commands.push.ts';
import { cmdUpdate } from './commands.update.ts';
import { HOME } from './config.ts';
import { cmdDiff } from './diff.ts';
import { cmdInit } from './init.ts';
import { parseFlags, parseInitArgs, parseRedactArgs } from './nomad.dispatch.ts';
import { DEFAULT_HELP } from './nomad.help.ts';
import { resumeCmd } from './resume.ts';
import { fail, NomadFatal } from './utils.ts';

/**
 * Static JSON import for the `--version` arm. Uses `with { type: 'json' }`
 * per Node 22+ import-attribute syntax (the older `assert { type: 'json' }`
 * was removed). Reading synchronously at module load avoids a runtime fs
 * walk on every `nomad --version` invocation and keeps the smoke-test
 * contract (in npm-publish.yml) deterministic.
 */
import pkg from '../package.json' with { type: 'json' };

if (!HOME) {
  fail(
    'could not determine home directory (HOME env unset and no uid mapping). Set HOME and retry.',
  );
  process.exit(1);
}

try {
  const cmd = process.argv[2];
  switch (cmd) {
    case '--version':
      // Early-arm placement so a broken --version invocation never falls
      // through to full command dispatch. Bare semver output (no prefix)
      // matches the contract asserted by the smoke-test step in
      // .github/workflows/npm-publish.yml (`nomad --version` strict-equal
      // to the published tag minus the leading `v`).
      if (process.argv.length !== 3) {
        console.error('usage: nomad --version (no extra arguments)');
        process.exit(1);
      }
      console.log(pkg.version);
      break;
    case 'pull': {
      // Sub-flag: `pull --dry-run` runs the full pull flow (lock + git pull)
      // in preview mode without mutating ~/.claude/. Any other argv after
      // `pull` is rejected so a typo does not silently degrade to a real pull.
      const sub = process.argv[3];
      if (sub === undefined) {
        cmdPull();
      } else if (sub === '--dry-run' && process.argv.length === 4) {
        cmdPull({ dryRun: true });
      } else {
        console.error('usage: nomad pull [--dry-run]');
        process.exit(1);
      }
      break;
    }
    case 'push': {
      // Set-based flag parse so --dry-run and --redact-all can appear in any
      // order; unknown flags show the usage line. --redact-all redacts every
      // finding non-interactively without requiring a TTY.
      const seen = parseFlags(process.argv, new Set(['--dry-run', '--redact-all']));
      if (seen === null) {
        console.error('usage: nomad push [--dry-run] [--redact-all]');
        process.exit(1);
      }
      await cmdPush({ dryRun: seen.has('--dry-run'), redactAll: seen.has('--redact-all') });
      break;
    }
    case 'init': {
      // parseInitArgs handles boolean flags (--snapshot, --keep-actions) and
      // the value-bearing --repo <name>. Returns null on any parse error:
      // unknown flag, duplicate, --repo with no value or a value starting with
      // '--'.
      const initArgs = parseInitArgs(process.argv);
      if (initArgs === null) {
        console.error('usage: nomad init [--snapshot] [--keep-actions] [--repo <name>]');
        process.exit(1);
      }
      cmdInit({
        snapshot: initArgs.snapshot,
        keepActions: initArgs.keepActions,
        repoName: initArgs.repoName,
      });
      break;
    }
    case 'diff':
      // Offline, lockless preview against local repo state. No git pull, no
      // lock acquisition. Reject any argv after `diff` since this slice
      // accepts no flags.
      if (process.argv.length > 3) {
        console.error('usage: nomad diff');
        process.exit(1);
      }
      cmdDiff();
      break;
    case 'update': {
      // Set-based parse so flag order does not matter and duplicates are
      // rejected (`--dry-run --dry-run` is a typo, not a no-op). Unknown
      // flags hit the same usage-error pattern as other subcommands.
      const seen = parseFlags(process.argv, new Set(['--dry-run', '--force', '--push-origin']));
      if (seen === null) {
        console.error('usage: nomad update [--dry-run] [--force] [--push-origin]');
        process.exit(1);
      }
      cmdUpdate({
        dryRun: seen.has('--dry-run'),
        force: seen.has('--force'),
        pushOrigin: seen.has('--push-origin'),
      });
      break;
    }
    case 'adopt': {
      // Required positional <name>; optional --dry-run. Any other shape
      // (missing name, leading-dash name, two positionals, unknown flag)
      // is a usage error. Single <name> per invocation (D-04).
      const name = process.argv[3];
      const sub = process.argv[4];
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.startsWith('-') ||
        (sub !== undefined && (sub !== '--dry-run' || process.argv.length !== 5))
      ) {
        console.error('usage: nomad adopt <name> [--dry-run]');
        process.exit(1);
      }
      cmdAdopt(name, { dryRun: sub === '--dry-run' });
      break;
    }
    case 'doctor':
      // Sub-flags: `doctor --resume-cmd <session-id>` dispatches to the
      // read-only sidecar that prints `cd <abspath> && claude --resume <id>`;
      // `doctor --check-shared` (no positional) appends the gitleaks preflight
      // scan of the transcripts a push would stage; `doctor --check-schema`
      // (no positional) appends the live settings-schema check. Bare `doctor`
      // runs the plain read-only health check. Any other shape (unknown flag,
      // extra positional, a scan flag with trailing args) is a usage error.
      if (process.argv[3] === undefined) {
        cmdDoctor();
      } else if (process.argv[3] === '--check-shared' && process.argv.length === 4) {
        cmdDoctor({ checkShared: true });
      } else if (process.argv[3] === '--check-schema' && process.argv.length === 4) {
        cmdDoctor({ checkSchema: true });
      } else if (process.argv[3] === '--resume-cmd') {
        const id = process.argv[4];
        if (process.argv.length !== 5 || typeof id !== 'string' || id.length === 0) {
          console.error('usage: nomad doctor --resume-cmd <session-id>');
          process.exit(1);
        }
        resumeCmd(id);
      } else {
        console.error(
          'usage: nomad doctor [--check-shared | --check-schema | --resume-cmd <session-id>]',
        );
        process.exit(1);
      }
      break;
    case 'drop-session': {
      // Single positional argv; cmdDropSession revalidates id at entry as
      // defense-in-depth (the function may be called from non-argv paths
      // in tests). The argv regex mirrors the function-entry allowlist
      // (`[\w-]`) but additionally rejects ids starting with `-`
      // so a typo like `nomad drop-session --bogus` shows the usage line,
      // not a FATAL. The length bound matches cmdDropSession.
      const id = process.argv[3];
      if (process.argv.length !== 4 || typeof id !== 'string' || !/^\w[\w-]{0,127}$/.test(id)) {
        console.error('usage: nomad drop-session <id>');
        process.exit(1);
      }
      cmdDropSession(id);
      break;
    }
    case 'redact': {
      // nomad redact <session-id> [--rule <rule-id>] [--dry-run]
      // parseRedactArgs handles the positional id, optional --rule <value>,
      // and optional --dry-run; returns null on any parse error.
      const redactArgs = parseRedactArgs(process.argv);
      if (redactArgs === null) {
        console.error('usage: nomad redact <session-id> [--rule <rule-id>] [--dry-run]');
        process.exit(1);
      }
      cmdRedact(redactArgs);
      break;
    }
    default:
      console.error(DEFAULT_HELP);
      process.exit(1);
  }
} catch (err) {
  // Top-level safety net for NomadFatal thrown from contexts that don't have
  // their own try/catch (e.g., cmdDoctor's readJson path). cmdPull / cmdPush
  // have their own catches so their finally blocks release the lock first.
  if (err instanceof NomadFatal) {
    fail(err.message);
    process.exit(1);
  }
  throw err;
}
