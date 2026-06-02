---
title: Commands
description: Full CLI command reference for claude-nomad.
---

Every command is invoked as `nomad <command>`. Each section below names the command, shows its
full invocation, and lists any flags in its own table.

## `init`

`nomad init [--repo <name>] [--snapshot] [--keep-actions]`

Create a private GitHub repo via `gh`, wire it as `origin`, disable Actions, scaffold `shared/`,
`hosts/`, `path-map.json`, and push. Prompts for a repo name (default: `claude-nomad-config`). `gh`
must be installed and authenticated; exits with FATAL otherwise. Refuses to clobber existing
scaffold. See [Quickstart](/quickstart/) for privacy details.

| Flag             | Description                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--repo <name>`  | Non-interactive: use `<name>` as the private repo name without prompting. Useful in scripts.                                                                                          |
| `--snapshot`     | Overlay current host's `~/.claude/` into `shared/` and write `~/.claude/settings.json` verbatim into `hosts/<NOMAD_HOST>.json`. Originals not modified. Same auto-disable behavior.   |
| `--keep-actions` | Skip the Actions-disable step. Combinable with `--snapshot` and `--repo`. Use when an org policy already governs Actions, or you intentionally want CI on the private repo.           |

## `pull`

`nomad pull [--dry-run]`

`git pull --rebase --autostash`, apply symlinks, regenerate `settings.json`, remap session paths,
and pull opted-in per-project extras. Errors out if scaffold missing.

| Flag        | Description                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run` | Network-aware preview: acquire lock + `git pull --rebase`, print planned changes (symlink moves, `settings.json` diff, transcript overwrites), no writes.    |

## `diff`

`nomad diff`

Offline, lockless twin of `pull --dry-run`. No network, no lock. Works against the current local
repo state.

## `push`

`nomad push [--dry-run] [--redact-all] [--allow <rule>] [--allow-all]`

Export local sessions and opted-in per-project extras to logical names, commit
(`chore: sync from <NOMAD_HOST>`), push.

| Flag               | Description                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`        | Run pre-push safety checks (gitleaks probe, rebase, remap preview, gitlink scan, allow-list) and a read-only gitleaks leak preview over a throwaway temp copy of the sessions and extras this host would stage. Exits 1 if a leak is found. Nothing is written.    |
| `--redact-all`     | Redact all findings non-interactively (backup written first) without a TTY. Does not auto-Allow findings. After redaction re-stages and re-scans; aborts with the session-aware FATAL if any finding survives. Mutually exclusive with `--allow*`. See [Recovery flows](/recovery/). |
| `--allow <rule>`   | Append the fingerprint of every finding whose gitleaks rule id matches `<rule>` to `.gitleaksignore`, re-stage, and re-scan. Proceeds only when no finding survives. Never skips scanning. No TTY required. Mutually exclusive with `--redact-all` and `--allow-all`; cannot combine with `--dry-run`. See [Recovery flows](/recovery/). |
| `--allow-all`      | Append the fingerprint of every current finding to `.gitleaksignore`, re-stage, and re-scan. Proceeds only when no finding survives. Never skips scanning. No TTY required. Mutually exclusive with `--redact-all` and `--allow`; cannot combine with `--dry-run`. See [Recovery flows](/recovery/). |

## `drop-session`

`nomad drop-session <id>`

Surgically unstage every `shared/projects/*/<id>.jsonl` and the sibling `shared/projects/*/<id>/`
subagent directory from the staged tree of `~/claude-nomad/`. Idempotent; the local
`~/.claude/projects/<encoded>/<id>.jsonl` and `<id>/` tree are preserved. See
[Recovery flows](/recovery/).

## `adopt`

`nomad adopt <name> [--dry-run]`

Back up, then move a pre-existing `~/.claude/<name>` directory into `shared/<name>`, recreate the
symlink so this host keeps working, and stage the result for push. `<name>` must already be listed
in `SHARED_LINKS` or in the `sharedDirs` field of `path-map.json`; adopt is a mover, not a config
editor, so it never writes `path-map.json` itself.

| Flag        | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `--dry-run` | Preview the planned backup, move, and `git add` without touching the filesystem or the git index. |

## `redact`

`nomad redact <session-id> [--rule <id>] [--dry-run]`

Rewrite the secret span across a session's local source transcripts (the main transcript plus any
subagent transcripts under `<session-id>/`), backed up to `~/.cache/claude-nomad/backup/`. Refuses
to touch a session that was modified recently (potential active session). Safe to re-run. See
[Recovery flows](/recovery/).

| Flag          | Description                                            |
| ------------- | ----------------------------------------------------- |
| `--rule <id>` | Limit redaction to findings of one gitleaks rule id only. |
| `--dry-run`   | Show what `nomad redact` would change without writing anything. |

## `allow`

`nomad allow <fingerprint>...`

Append one or more gitleaks fingerprints to `<REPO_HOME>/.gitleaksignore` without going through a
push cycle. Use this to pre-record confirmed false positives so the next `nomad push` does not
prompt for them. Fingerprints come from a previous `nomad push` finding report or a
`nomad doctor --check-shared` scan; the format is `file:rule:line` (the opaque string gitleaks
emits, shown in the scan output).

Idempotent: a fingerprint already present in `.gitleaksignore` is silently skipped. An invalid
fingerprint (empty, containing a newline, or over 512 characters) causes the command to exit 1 on
the first bad value; valid fingerprints before it are still written. No flags are accepted.

See [Recovery flows](/recovery/) for the non-interactive push allow paths
(`nomad push --allow <rule>` and `nomad push --allow-all`), which record fingerprints AND
re-scan in a single step.

## `clean`

`nomad clean --backups [--older-than <dur>] [--keep <N>] [--dry-run]`

Delete old backup snapshots under `~/.cache/claude-nomad/backup/`. The `--backups` flag is required.
By default (no retention flag) removes snapshots older than 14 days. Always preview with `--dry-run`
first. See [Recovery flows](/recovery/).

| Flag                | Description                                                                            |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--backups`         | Required: confirm backup pruning is the intended target.                              |
| `--older-than <dur>`| Delete snapshots older than this age (e.g. `7d`, `24h`). Default when omitted: 14 days. |
| `--keep <N>`        | Keep the N newest snapshots and delete the rest. Cannot be combined with `--older-than`. |
| `--dry-run`         | List the snapshots that would be removed without deleting.                             |

## `update`

`nomad update`

Update the `nomad` CLI binary from npm (`npm update -g claude-nomad`). Does NOT pull your sync data;
run `nomad pull` separately for that. See [Usage](/usage/).

## `doctor`

`nomad doctor [--resume-cmd <id>] [--check-shared] [--check-schema]`

Read-only health check. Each line carries a status glyph (`✓` pass, `✗` fail, `⚠︎` warn); any `✗`
sets `process.exitCode = 1` (`⚠︎` does not). Includes an offline-tolerant release-version staleness
check, a Hook targets check that fails (`✗`, exit 1) when `settings.json` references a hook command
whose script under `~/.claude/` is missing on this host, plus a set of `⚠︎`-only checks: gitleaks
version drift; on a private GitHub repo, re-enabled Actions; optional-dependency presence (`gh`
and the curl-or-wget HTTP fetcher); a backups-cache size/count nudge toward `nomad clean --backups`;
an ESM/CommonJS hook-scope mismatch; and a Node-engine floor check.

| Flag                | Description                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--resume-cmd <id>` | Print a host-local `cd ... && claude --resume <id>` line for a session. See [Usage](/usage/).                                                                                         |
| `--check-shared`    | Read-only gitleaks preflight: stages the session transcripts a `push` would publish into a temp tree and scans them, failing (`✗`, exit 1) per affected session. Skips with a `⚠︎` when gitleaks is not on PATH. See [Recovery flows](/recovery/). |
| `--check-schema`    | Read-only: fetches the live Claude Code settings schema and lists any `~/.claude/settings.json` key absent from it. Non-fatal and offline-tolerant: skips with a `⚠︎` when neither curl nor wget is available or the schema is unreachable. |

### Output details

The version-check emits a warning when the local install is behind the latest upstream release,
and a pass line when current. It silently skips on network failures.

The Hook targets check reads the live `~/.claude/settings.json` `hooks` block and fails (`✗`,
exit 1) when a hook command points at a script under `~/.claude/` that is missing on this host
(the freshly-configured-host symptom that motivated syncing `hooks/`). It deliberately skips any
command it cannot resolve to a `~/.claude/` path (bare binaries like `jq`, unresolved env vars),
so it never false-fails on a command that does not reference a local script.

Two further warning-only drift checks run in `nomad doctor`. The gitleaks version-drift line fires
when the local gitleaks major.minor differs from the CI-pinned `GITLEAKS_PINNED_VERSION` (gitleaks
rule and allowlist behavior tracks the minor line, so a patch-only difference stays as a pass),
and is silent when gitleaks is not on PATH. The Actions-drift line (carrying a
`gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false` remediation hint) fires
when origin is a private GitHub repo that is gh-authed with Actions re-enabled, complementing
the auto-disable that runs on `nomad init` (see [Quickstart](/quickstart/)); it is silent on every
prerequisite miss (non-GitHub origin, `gh` unauthed, public repo, or Actions already off).

## Global flags

`nomad --version`

Print the installed CLI version as bare semver to stdout; exits 0. Used by the npm-publish smoke
test and useful for ad-hoc upgrade checks.
