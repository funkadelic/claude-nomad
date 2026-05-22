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
import { cmdDropSession } from './commands.drop-session.ts';
import { cmdPull } from './commands.pull.ts';
import { cmdPush } from './commands.push.ts';
import { cmdUpdate } from './commands.update.ts';
import { HOME } from './config.ts';
import { cmdDiff } from './diff.ts';
import { cmdInit } from './init.ts';
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

/**
 * Multi-line help block printed on the `default:` arm of the dispatcher
 * (bare `nomad` and any unknown subcommand). Per-subcommand `usage:` lines
 * stay terse and live inside their own `case` arms; this block exists so a
 * cold invocation of `nomad` is self-describing without forcing the user
 * into the README. Channel is stderr, exit code is 1.
 */
const DEFAULT_HELP = [
  'usage: nomad <command> [flags]',
  '',
  'Commands:',
  '  pull             Sync ~/.claude/ from the shared repo (settings, symlinks, sessions).',
  '       --dry-run   Run lock + git pull, then preview every mutation without writing.',
  '',
  '  push             Rebase, run safety checks (gitleaks, gitlinks, allow-list), commit, push.',
  '       --dry-run   Run pre-checks (rebase, gitleaks probe, gitlink scan) and preview',
  '                   remap, without staging or pushing.',
  '',
  '  diff             Offline preview of what `pull` would change against local repo state.',
  '                   No git pull, no lock acquired.',
  '',
  '  init             Scaffold an empty ~/claude-nomad/ repo (shared/, hosts/, path-map).',
  '       --snapshot      Overlay the current ~/.claude/ into shared/ as the initial seed.',
  '       --keep-actions  Skip auto-disabling GitHub Actions on the private mirror.',
  '',
  '  doctor                  Read-only health check (symlinks, host file, path-map,',
  '                          gitleaks, gitlinks).',
  '       --resume-cmd <id>  Print `cd <abspath> && claude --resume <id>` for a session id',
  '                          from ~/.claude/projects/.',
  '',
  '  drop-session <id>   Unstage shared/projects/<logical>/<id>.jsonl from the staged tree (local ~/.claude/projects is never touched).',
  '',
  '  update              Topology-aware upgrade of ~/claude-nomad/ to the latest upstream.',
  '       --dry-run      Detect topology + pre-flight, print would-be git commands only.',
  '       --force        Proceed even when the working tree is not clean.',
  '       --push-origin  Fork topology only: push the merge to origin/main without prompting.',
  '',
  'Run `nomad doctor` to validate your setup. Edit shared/ or hosts/<HOST>.json',
  'in the repo, never ~/.claude/settings.json directly (it is regenerated on',
  'every pull).',
].join('\n');

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
      // Sub-flag: `push --dry-run` runs the pre-checks and remap preview
      // without staging, scanning, committing, or pushing. Any other argv
      // after `push` is rejected so a typo does not silently degrade.
      const sub = process.argv[3];
      if (sub === undefined) {
        cmdPush();
      } else if (sub === '--dry-run' && process.argv.length === 4) {
        cmdPush({ dryRun: true });
      } else {
        console.error('usage: nomad push [--dry-run]');
        process.exit(1);
      }
      break;
    }
    case 'init': {
      // Set-based parse so flag order does not matter and duplicates are
      // rejected. Unknown flags hit the same usage-error pattern as other
      // subcommands.
      const known = new Set(['--snapshot', '--keep-actions']);
      const seen = new Set<string>();
      let argvOk = true;
      for (let i = 3; i < process.argv.length; i++) {
        const flag = process.argv[i];
        if (!known.has(flag) || seen.has(flag)) { argvOk = false; break; }
        seen.add(flag);
      }
      if (!argvOk) {
        console.error('usage: nomad init [--snapshot] [--keep-actions]');
        process.exit(1);
      }
      cmdInit({ snapshot: seen.has('--snapshot'), keepActions: seen.has('--keep-actions') });
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
      const known = new Set(['--dry-run', '--force', '--push-origin']);
      const seen = new Set<string>();
      let argvOk = true;
      for (let i = 3; i < process.argv.length; i++) {
        const flag = process.argv[i];
        if (!known.has(flag) || seen.has(flag)) {
          argvOk = false;
          break;
        }
        seen.add(flag);
      }
      if (!argvOk) {
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
    case 'drop-session': {
      // Single positional argv; cmdDropSession revalidates id at entry as
      // defense-in-depth (the function may be called from non-argv paths
      // in tests). The argv regex mirrors the function-entry allowlist
      // (`[A-Za-z0-9_-]`) but additionally rejects ids starting with `-`
      // so a typo like `nomad drop-session --bogus` shows the usage line,
      // not a FATAL. The length bound matches cmdDropSession.
      const id = process.argv[3];
      if (
        process.argv.length !== 4 ||
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(id)
      ) {
        console.error('usage: nomad drop-session <id>');
        process.exit(1);
      }
      cmdDropSession(id);
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
