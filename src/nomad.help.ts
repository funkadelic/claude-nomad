/**
 * Multi-line help block printed on the `default:` arm of the dispatcher
 * (bare `nomad` and any unknown subcommand). Per-subcommand `usage:` lines
 * stay terse and live inside their own `case` arms; this block exists so a
 * cold invocation of `nomad` is self-describing without forcing the user
 * into the README. Channel is stderr, exit code is 1.
 */

import pkg from '../package.json' with { type: 'json' };

/**
 * Column (0-indexed) at which every command and flag description starts. Sized
 * to clear the longest label (`--resume-cmd <id>`, which ends at column 24)
 * with a two-space gutter. A single constant is what keeps every row aligned;
 * padding lines by hand is how a description drifts out of column.
 */
const DESC_COL = 26;

/**
 * Render a `label` + `desc` help row, padding the label out to DESC_COL so the
 * description lands in the shared column. `padEnd` is a no-op when a label is
 * already at or past the column, so no row can throw or fall out of alignment.
 */
const row = (label: string, desc: string): string => label.padEnd(DESC_COL) + desc;

/**
 * Indent a continuation line (wrapped description text with no label of its
 * own) to DESC_COL so it sits directly under the description column.
 */
const cont = (text: string): string => ' '.repeat(DESC_COL) + text;

export const DEFAULT_HELP = [
  `claude-nomad v${pkg.version}`,
  '',
  'usage: nomad <command> [flags]',
  '',
  'Commands:',
  row('  pull', 'Sync ~/.claude/ from the shared repo (settings, symlinks, sessions).'),
  row('       --dry-run', 'Run lock + git pull, then preview every mutation without writing.'),
  row('       --force-remote', 'Recover from a wedged repo (stuck mid-rebase or mid-merge):'),
  cont('abort the in-progress rebase/merge, park stranded commits on'),
  cont('nomad/stranded-<ts>, reset to origin/main, and re-pull. Refuses'),
  cont('if stranded or dirty tracked changes touch synced config (shared/,'),
  cont('hosts/, path-map.json). Cannot combine with --dry-run.'),
  '',
  row('  push', 'Rebase, run safety checks (gitleaks, gitlinks, allow-list), commit, push.'),
  row('       --dry-run', 'Run pre-checks (rebase, gitleaks probe, gitlink scan) and preview'),
  cont('remap, without staging or pushing.'),
  row('       --redact-all', 'Redact all findings non-interactively (backup, no prompt); no TTY'),
  cont('required. Does not auto-Allow. Mutually exclusive with --allow*.'),
  cont('Cannot combine with --dry-run.'),
  row(
    '       --allow <rule>',
    'Allow (append .gitleaksignore fingerprint for) findings matching a gitleaks',
  ),
  cont('rule id, then re-scan; proceeds only when no finding survives. No TTY'),
  cont('required. Never skips the scan. Mutually exclusive with --redact-all/--allow-all.'),
  cont('Cannot combine with --dry-run.'),
  row(
    '       --allow-all',
    'Allow every current finding non-interactively, then re-scan; proceeds only',
  ),
  cont('when no finding survives. No TTY required. Never skips the scan.'),
  cont('Mutually exclusive with --redact-all/--allow. Cannot combine with --dry-run.'),
  '',
  row('  diff', 'Offline preview of what `pull` would change against local repo state.'),
  cont('No git pull, no lock acquired.'),
  '',
  row(
    '  init',
    'Create a private GitHub repo via gh (if none exists), scaffold shared/, hosts/, path-map.',
  ),
  row('       --snapshot', 'Overlay the current ~/.claude/ into shared/ as the initial seed.'),
  row('       --keep-actions', 'Skip auto-disabling GitHub Actions on the private repo.'),
  row(
    '       --repo <name>',
    'Name for the new GitHub repo (default: claude-nomad-config). No-op when origin exists.',
  ),
  '',
  row('  doctor', 'Read-only health check (symlinks, host file, path-map,'),
  cont('gitleaks, gitlinks). Compact by default: shows problems plus a verdict.'),
  row('       --verbose, --all, -v', 'Show the full per-check tree, including passing checks.'),
  row('       --check-shared', 'Preflight gitleaks scan of the session transcripts a'),
  cont('`nomad push` would stage (a temp copy, never the live dir).'),
  row('       --check-schema', 'Flag settings.json keys absent from the live published'),
  cont('Claude Code settings schema (needs network; degrades offline).'),
  row('       --resume-cmd <id>', 'Print `cd <abspath> && claude --resume <id>` for a session id'),
  cont('from ~/.claude/projects/.'),
  '',
  row(
    '  drop-session <id>',
    'Unstage shared/projects/<logical>/<id>.jsonl from the staged tree (local ~/.claude/projects is never touched).',
  ),
  '',
  row(
    '  adopt <name>',
    'Move a pre-existing ~/.claude/<name> dir into shared/<name>, recreate the',
  ),
  cont('symlink, and stage for push. <name> must be in SHARED_LINKS or sharedDirs.'),
  row('       --dry-run', 'Preview backup, move, and git-add without writing.'),
  '',
  row('  eject', 'Materialize every managed ~/.claude/ symlink into a real copy so the'),
  cont('setup keeps working after deleting the sync repo. Prints a'),
  cont('manual-remainder checklist (uninstall CLI, drop env vars, optional deletes).'),
  row('       --dry-run', 'List what would be materialized without writing anything.'),
  '',
  row(
    '  capture-settings',
    'Promote local-only settings.json keys into the shared repo so they survive',
  ),
  cont('the next pull. Backs up the destination, writes atomically, then regenerates'),
  cont('settings.json so local matches. Idempotent when no local-only keys remain.'),
  cont('Prompts for confirmation before writing (shows the destination and keys).'),
  row('       --host', 'Write into hosts/<HOST>.json (host-specific values) instead of'),
  cont('shared/settings.base.json (default; normalizes absolute node launcher paths).'),
  row(
    '       --dry-run',
    'Show the destination and keys that would be written without changing anything.',
  ),
  row('       --yes, -y', 'Skip the confirmation prompt (required in a non-interactive shell).'),
  '',
  row(
    '  redact <session-id>',
    'Rewrite the secret span in the local source transcript for a session,',
  ),
  cont('backed up to ~/.cache/claude-nomad/backup/. Safe to re-run.'),
  row('       --rule <id>', 'Limit redaction to one gitleaks rule id.'),
  row('       --dry-run', 'Show what would change without writing.'),
  '',
  row(
    '  allow <fingerprint>...',
    'Record a gitleaks false positive: append one or more fingerprints to',
  ),
  cont('REPO_HOME/.gitleaksignore without the interactive recovery menu.'),
  cont('Idempotent: a fingerprint already present is silently skipped.'),
  '',
  row('  update', 'Update the claude-nomad CLI to the latest npm release.'),
  '',
  row('  clean', 'Prune old backup snapshots under ~/.cache/claude-nomad/backup/.'),
  row('       --backups', 'Required: confirm backup pruning is the intended target.'),
  row('       --dry-run', 'List the snapshots that would be removed without deleting.'),
  row('       --older-than <dur>', 'Delete snapshots older than a duration (e.g. 14d, 24h, 30m).'),
  cont('Default when no retention flag is given: 14d.'),
  row('       --keep <N>', 'Keep the N most-recent snapshots, delete the rest. Mutually'),
  cont('exclusive with --older-than.'),
  '',
  row('  --version', 'Print the installed CLI version as bare semver to stdout; exits 0.'),
  '',
  'Run `nomad doctor` to validate your setup. Edit shared/ or hosts/<HOST>.json',
  'in the repo, never ~/.claude/settings.json directly (it is regenerated on',
  'every pull).',
].join('\n');
