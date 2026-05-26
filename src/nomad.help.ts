/**
 * Multi-line help block printed on the `default:` arm of the dispatcher
 * (bare `nomad` and any unknown subcommand). Per-subcommand `usage:` lines
 * stay terse and live inside their own `case` arms; this block exists so a
 * cold invocation of `nomad` is self-describing without forcing the user
 * into the README. Channel is stderr, exit code is 1.
 */
export const DEFAULT_HELP = [
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
  '       --check-shared     Preflight gitleaks scan of the session transcripts a',
  '                          `nomad push` would stage (a temp copy, never the live dir).',
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
