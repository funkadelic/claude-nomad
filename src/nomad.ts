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
import { cmdAllow } from './commands.allow.ts';
import { cmdCaptureSettings } from './commands.capture-settings.ts';
import { cmdClean } from './commands.clean.ts';
import { cmdEject } from './commands.eject.ts';
import { cmdDoctor } from './commands.doctor.ts';
import { parseDoctorArgs } from './nomad.dispatch.doctor.ts';
import { cmdDropSession } from './commands.drop-session.ts';
import { cmdRedact } from './commands.redact.ts';
import { cmdPull } from './commands.pull.ts';
import { cmdPush } from './commands.push.ts';
import { cmdUpdate } from './commands.update.ts';
import { home } from './config.ts';
import { cmdDiff } from './diff.ts';
import { cmdInit } from './init.ts';
import { parseCleanArgs } from './nomad.dispatch.clean.ts';
import { parseCaptureSettingsArgs } from './nomad.dispatch.capture-settings.ts';
import { parseEjectArgs } from './nomad.dispatch.eject.ts';
import { parseInitArgs, parseRedactArgs } from './nomad.dispatch.ts';
import { parseAllowArgs } from './nomad.dispatch.allow.ts';
import { parsePullArgs } from './nomad.dispatch.pull.ts';
import { parsePushArgs } from './nomad.dispatch.push.ts';
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

const h = home();
if (!h) {
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
      // parsePullArgs handles --dry-run and --force-remote; rejects duplicates,
      // unknown tokens, and the --dry-run + --force-remote combination
      // (a dry-run mutates nothing; recovery mutates).
      const pullArgs = parsePullArgs(process.argv);
      if (pullArgs === null) {
        console.error('usage: nomad pull [--dry-run] [--force-remote]');
        process.exit(1);
      }
      cmdPull({ dryRun: pullArgs.dryRun, forceRemote: pullArgs.forceRemote });
      break;
    }
    case 'push': {
      // Value-aware parse: --dry-run / --redact-all are boolean; --allow <rule>
      // is value-bearing; --allow-all is boolean. --redact-all, --allow-all, and
      // --allow are mutually exclusive resolution modes; --allow* + --dry-run is
      // also rejected (a dry-run resolves nothing).
      const pushArgs = parsePushArgs(process.argv);
      if (pushArgs === null) {
        console.error(
          'usage: nomad push [--dry-run] [--redact-all] [--allow <rule>] [--allow-all]',
        );
        process.exit(1);
      }
      await cmdPush({
        dryRun: pushArgs.dryRun,
        redactAll: pushArgs.redactAll,
        allowAll: pushArgs.allowAll,
        allowRule: pushArgs.allowRule,
      });
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
      // No flags accepted; any extra argv is a usage error (same length-check
      // pattern as the --version arm).
      if (process.argv.length !== 3) {
        console.error('usage: nomad update');
        process.exit(1);
      }
      cmdUpdate(pkg.version);
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
    case 'eject': {
      // parseEjectArgs accepts only --dry-run; rejects duplicates, unknown
      // tokens, and extra positional arguments.
      const ejectArgs = parseEjectArgs(process.argv);
      if (ejectArgs === null) {
        console.error('usage: nomad eject [--dry-run]');
        process.exit(1);
      }
      cmdEject({ dryRun: ejectArgs.dryRun });
      break;
    }
    case 'capture-settings': {
      // parseCaptureSettingsArgs accepts --host, --dry-run, and --yes/-y;
      // rejects duplicates, unknown tokens, and extra positional arguments.
      const captureArgs = parseCaptureSettingsArgs(process.argv);
      if (captureArgs === null) {
        console.error('usage: nomad capture-settings [--host] [--dry-run] [--yes]');
        process.exit(1);
      }
      await cmdCaptureSettings({
        host: captureArgs.host,
        dryRun: captureArgs.dryRun,
        yes: captureArgs.yes,
      });
      break;
    }
    case 'doctor': {
      // `parseDoctorArgs` resolves the argv tail: `--resume-cmd <id>` prints the
      // resume command (exclusive); `--check-shared` / `--check-schema` /
      // `--check-remote` append the gitleaks preflight, live settings-schema
      // scan, and remote structural probe; `--verbose` / `--all` / `-v` restore
      // the full tree (bare `doctor` is compact). Any other shape is a usage error.
      const parsed = parseDoctorArgs(process.argv.slice(3));
      if (parsed.kind === 'error') {
        console.error(
          'usage: nomad doctor [--check-shared] [--check-schema] [--check-remote] [--verbose|--all|-v]' +
            ' | --resume-cmd <session-id>',
        );
        process.exit(1);
      } else if (parsed.kind === 'resume') {
        resumeCmd(parsed.id);
      } else {
        cmdDoctor({
          checkShared: parsed.checkShared,
          checkSchema: parsed.checkSchema,
          checkRemote: parsed.checkRemote,
          verbose: parsed.verbose,
        });
      }
      break;
    }
    case 'drop-session': {
      // Single positional argv; cmdDropSession revalidates the id at entry.
      // The argv regex mirrors that allowlist but rejects leading-dash ids so
      // `nomad drop-session --bogus` shows usage rather than a FATAL.
      const id = process.argv[3];
      if (process.argv.length !== 4 || typeof id !== 'string' || !/^\w[\w-]{0,127}$/.test(id)) {
        console.error('usage: nomad drop-session <id>');
        process.exit(1);
      }
      cmdDropSession(id);
      break;
    }
    case 'redact': {
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
    case 'allow': {
      // parseAllowArgs collects one or more positional fingerprints from
      // argv[3]+; returns null when none are given or any starts with '-'.
      const allowArgs = parseAllowArgs(process.argv);
      if (allowArgs === null) {
        console.error('usage: nomad allow <fingerprint> [<fingerprint>...]');
        process.exit(1);
      }
      cmdAllow(allowArgs);
      break;
    }
    case 'clean': {
      // parseCleanArgs requires --backups and rejects --older-than + --keep
      // together; cmdClean re-enforces that exclusion as defense-in-depth.
      const cleanArgs = parseCleanArgs(process.argv);
      if (cleanArgs === null) {
        console.error('usage: nomad clean --backups [--dry-run] [--older-than <dur> | --keep <N>]');
        process.exit(1);
      }
      cmdClean(cleanArgs);
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
