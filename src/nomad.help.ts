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
  '',
  row('  push', 'Rebase, run safety checks (gitleaks, gitlinks, allow-list), commit, push.'),
  row('       --dry-run', 'Run pre-checks (rebase, gitleaks probe, gitlink scan) and preview'),
  cont('remap, without staging or pushing.'),
  row('       --redact-all', 'Redact all findings non-interactively (backup, no prompt); no TTY'),
  cont('required. Does not auto-Allow.'),
  '',
  row('  diff', 'Offline preview of what `pull` would change against local repo state.'),
  cont('No git pull, no lock acquired.'),
  '',
  row(
    '  init',
    'Create a private GitHub repo via gh (if none exists), scaffold shared/, hosts/, path-map.',
  ),
  row('       --snapshot', 'Overlay the current ~/.claude/ into shared/ as the initial seed.'),
  row('       --keep-actions', 'Skip auto-disabling GitHub Actions on the private mirror.'),
  row(
    '       --repo <name>',
    'Name for the new GitHub repo (default: claude-nomad-config). No-op when origin exists.',
  ),
  '',
  row('  doctor', 'Read-only health check (symlinks, host file, path-map,'),
  cont('gitleaks, gitlinks).'),
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
  row(
    '  redact <session-id>',
    'Rewrite the secret span in the local source transcript for a session,',
  ),
  cont('backed up to ~/.cache/claude-nomad/backup/. Safe to re-run.'),
  row('       --rule <id>', 'Limit redaction to one gitleaks rule id.'),
  row('       --dry-run', 'Show what would change without writing.'),
  '',
  row('  update', 'Update the claude-nomad CLI to the latest npm release.'),
  '',
  row('  --version', 'Print the installed CLI version as bare semver to stdout; exits 0.'),
  '',
  'Run `nomad doctor` to validate your setup. Edit shared/ or hosts/<HOST>.json',
  'in the repo, never ~/.claude/settings.json directly (it is regenerated on',
  'every pull).',
].join('\n');
