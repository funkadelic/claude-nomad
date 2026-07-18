---
title: Commands
description: Full CLI command reference for claude-nomad.
---

Every command is invoked as `nomad <command>`. Each section below names the command, shows its
full invocation, and lists any flags in its own table.

## `init`

`nomad init [--repo <name>] [--snapshot] [--keep-actions]`

Create a private GitHub repo via `gh`, wire it as `origin`, disable Actions, and scaffold `shared/`,
`hosts/`, `path-map.json`, and a root `.gitattributes` (`* -text`) that stops Git from rewriting
line endings between hosts (what would otherwise happen on a Windows checkout with the common
`core.autocrlf=true` default; `nomad doctor` warns when an older repo lacks the guard). Does not
commit or push; run `nomad push` afterward to publish. Prompts
for a repo name (default: `claude-nomad-config`). `gh`
must be installed and authenticated; exits with FATAL otherwise. Refuses to clobber existing
scaffold. Without `--snapshot`, an interactive `init` that finds an existing `~/.claude/` (a
`settings.json` or any non-empty shared source) offers to seed the repo from it; declining keeps the
empty scaffold, and a non-interactive shell skips the prompt and prints a `--snapshot` tip. See
[Quickstart](/claude-nomad/quickstart/) for privacy details.

| Flag             | Description                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--repo <name>`  | Non-interactive: use `<name>` as the private repo name without prompting. Useful in scripts.                                                                                          |
| `--snapshot`     | Overlay current host's `~/.claude/` into `shared/` and write `~/.claude/settings.json` verbatim into `hosts/<NOMAD_HOST>.json`. Originals not modified. Same auto-disable behavior. An interactive `init` offers this automatically when it detects existing config. |
| `--keep-actions` | Skip the Actions-disable step. Combinable with `--snapshot` and `--repo`. Use when an org policy already governs Actions, or you intentionally want CI on the private repo.           |

## `pull`

`nomad pull [--dry-run] [--force-remote]`

`git pull --rebase --autostash`, apply symlinks (real copies on native Windows), regenerate
`settings.json`, remap session paths,
and pull opted-in per-project extras. Errors out if scaffold missing. Non-destructive: unpushed
local-only session transcripts are retained, and a repo-tracked extras file you have edited locally
is kept (not overwritten) when it diverges from the incoming copy, with a warning to push and
reconcile.

| Flag             | Description                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`      | Network-aware preview: acquire lock + `git pull --rebase`, print planned changes (symlink moves, `settings.json` diff, transcript overwrites, an `Extras` section listing every `<logical>/<dirname>` a wet pull would copy including extras with no local copy yet, a count of retained local-only sessions, and any extras-divergence warning), no writes.                                                                            |
| `--force-remote` | Recover from a wedged sync repo. Two recovery paths depending on state: (1) stuck mid-rebase or mid-merge: abort the in-progress operation, park stranded commits on `nomad/stranded-<ts>`, reset to `origin/main`, and re-pull; refuses if stranded or dirty tracked changes touch synced config (shared/, hosts/, path-map.json). (2) unmerged index with no active rebase or merge: clear the stuck index via `git reset --mixed HEAD` (preserves working-tree edits), surface any orphaned autostash entry with a hint, and re-pull; no abort, no park step. Cannot combine with `--dry-run` (it performs mutations incompatible with preview mode). |

## `diff`

`nomad diff`

Offline, lockless twin of `pull --dry-run`. No network, no lock. Works against the current local
repo state. The `settings.json` diff filters gsd-owned hook entries from both sides before
comparing, so GSD's per-session hook self-heal does not show up as a phantom `hooks` change; the
preview reflects what a real pull would write. Also renders the same `Extras` section as
`pull --dry-run`, listing every `<logical>/<dirname>` a pull would copy, including extras with no
local copy yet.

## `push`

`nomad push [--dry-run] [--full-scan] [--redact-all] [--allow <rule>] [--allow-all]`

Export local sessions and opted-in per-project extras to logical names, commit
(`chore: sync from <NOMAD_HOST>`), push. Steady-state pushes scan only the
transcripts that changed since the last successful push (incremental); a cold
start, a gitleaks version change, a gitleaks config change, or `--full-scan`
forces a full rescan of all transcripts.

| Flag               | Description                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`        | Run pre-push safety checks (gitleaks probe, rebase, remap preview, gitlink scan, allow-list) and a read-only gitleaks leak preview over a throwaway temp copy of the sessions and extras this host would stage. Exits 1 if a leak is found. Nothing is written.    |
| `--full-scan`      | Ignore the per-host push manifest and rescan all transcripts, then rewrite the manifest on success. Use after a gitleaks upgrade, after editing a gitleaks config file, or when in doubt. Composes freely with `--dry-run` and all resolution modes. |
| `--redact-all`     | Redact all findings non-interactively (backup written first) without a TTY. Does not auto-Allow findings. After redaction re-stages and re-scans; aborts with the session-aware FATAL if any finding survives. Mutually exclusive with `--allow*`; cannot combine with `--dry-run`. See [Recovery flows](/claude-nomad/recovery/). |
| `--allow <rule>`   | Append the fingerprint of every finding whose gitleaks rule id matches `<rule>` to `.gitleaksignore`, re-stage, and re-scan. Proceeds only when no finding survives. Never skips scanning. No TTY required. Mutually exclusive with `--redact-all` and `--allow-all`; cannot combine with `--dry-run`. See [Recovery flows](/claude-nomad/recovery/). |
| `--allow-all`      | Append the fingerprint of every current finding to `.gitleaksignore`, re-stage, and re-scan. Proceeds only when no finding survives. Never skips scanning. No TTY required. Mutually exclusive with `--redact-all` and `--allow`; cannot combine with `--dry-run`. See [Recovery flows](/claude-nomad/recovery/). |

## `sync`

`nomad sync [--dry-run] [--verbose|--all|-v]`

The recommended everyday command: pulls first, then pushes, under a single lock, so you never
have to reason about which one to run first. The pull half is the same retain-merge overlay
`nomad pull` runs (local-only work is kept, a diverged extras file is kept local with a warning),
so it is always safe to run first; the push half then reconciles everything local, including any
local-only sessions and diverged extras files the pull half just retained, to the remote.

Output is compact by default, matching `nomad doctor`: a run prints its `sync on host=<HOST>`
header, then a single Sync summary composed from the run's outcome, not the full status tree.
Pass `--verbose` (or `--all` / `-v`) to also print the full merged status tree (Settings, Global
config, Sessions, Extras, and Leak scan, as applicable) before the summary, the same tree every
`nomad sync` run used to print unconditionally.

A pull-half failure (for example a wedged repo) stops the run immediately; no push is attempted.
Run `nomad pull --force-remote` to recover, then re-run `nomad sync` (`sync` itself has no
`--force-remote` flag; that recovery stays on the low-level `pull` command). A push-half failure
after a successful pull reports `pull: applied, push: failed (<reason>)` and exits non-zero; there
is no rollback, since the pull half already retained everything and made local state strictly
better than before. A run where neither half changed anything prints a single compact
`already in sync` line. If the sync repo holds commits that never reached the remote (for example a
push interrupted mid-run), the run does not claim to be in sync; the Sync summary adds a
`sync repo has unpushed commits` note instead. A run where the pull half retained diverged extras
or local-only sessions and the push half then reconciled them still exits 0, with the push row's
own parenthetical naming how many items were reconciled (this is treated as resolved work, not a
standing problem). If `nomad push`'s secret scan finds something mid-sync, the same interactive
Redact/Allow/Drop/Skip menu you would see from a plain `nomad push` opens; recovery behaves
identically either way.

`--dry-run` previews both halves without writing anything: the pull preview renders first, then a
one-line note that the push preview below is computed against pre-pull state (a real sync runs the
push half after the pull half has already applied, so its staging set can differ slightly), then
the push preview.

`nomad push` and `nomad pull` remain available as lower-level commands for cases `sync` does not
cover, such as `--force-remote` wedge recovery or the non-interactive leak-resolution flags
(`--redact-all`, `--allow`, `--allow-all`, `--full-scan`).

| Flag                     | Description                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `--dry-run`              | Stack the pull preview then the push preview; acquires the lock, writes nothing. |
| `--verbose`, `--all`, `-v` | Print the full merged status tree before the Sync summary; default output is the summary alone. |

## `drop-session`

`nomad drop-session <id>`

Surgically unstage every `shared/projects/*/<id>.jsonl` and the sibling `shared/projects/*/<id>/`
subagent directory from the staged tree of `~/claude-nomad/`. Idempotent; the local
`~/.claude/projects/<encoded>/<id>.jsonl` and `<id>/` tree are preserved. See
[Recovery flows](/claude-nomad/recovery/).

## `adopt`

`nomad adopt <name> [--dry-run]`

Back up, then move a pre-existing `~/.claude/<name>` directory into `shared/<name>`, recreate the
symlink so this host keeps working, and stage the result for push. `<name>` must already be listed
in `SHARED_LINKS` or in the `sharedDirs` field of `path-map.json`; adopt is a mover, not a config
editor, so it never writes `path-map.json` itself. On native Windows adopt recreates the name as a
real copy instead of a symlink (the win32 copy-sync modality). On Windows a name whose
`shared/<name>` counterpart already exists is reported as already adopted and skipped (with a
`nomad pull` hint to refresh the local copy), where macOS/Linux would refuse with a would-clobber
error.

| Flag        | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `--dry-run` | Preview the planned backup, move, and `git add` without touching the filesystem or the git index. |

## `eject`

`nomad eject [--dry-run]`

Replace every managed `~/.claude/` symlink with a real dereferenced copy so your setup keeps
working after you delete the `~/claude-nomad/` checkout and uninstall the CLI. The set of managed
names is the same union of `SHARED_LINKS` and validated `sharedDirs` entries that `nomad pull`
manages (the authoritative list is `allSharedLinks` in `src/config.ts`). Names that are already
real files or directories are reported as skipped and left unchanged; absent names are also
skipped. A managed name that is a symlink pointing outside the sync repo's `shared/` directory is
skipped as not nomad-managed and left untouched, so eject only materializes links it owns. A
dangling symlink (the target is missing) causes the whole command to abort before any
copy is written, with a hint to run `nomad pull` first to restore the missing target. After all
copies succeed, eject prints a checklist of the manual steps remaining: uninstall the CLI, remove
`NOMAD_HOST` and `NOMAD_REPO` from your shell rc, and optionally delete the local sync checkout
and backup cache. `eject` never writes to the sync repo, never invokes git, and never touches
`~/.claude/projects/` (session transcripts are already real files). On native Windows there is
usually nothing to materialize: under the win32 copy-sync modality the managed names are already
real copies, so each is reported as `already a real copy (win32 copy-sync)` and only the manual
checklist remains.

| Flag        | Description                                                                  |
| ----------- | ---------------------------------------------------------------------------- |
| `--dry-run` | List what would be materialized without touching the filesystem.             |

## `capture-settings`

`nomad capture-settings [--host] [--dry-run] [--yes]`

Promote local-only `~/.claude/settings.json` keys into the shared repo so they survive the next
`nomad pull`. Use this when an external tool (such as Claude Code or GSD) added new keys to your
live settings file that are not yet in `shared/settings.base.json` or your host override. After
writing the destination file, `capture-settings` calls `regenerateSettings` so the local
`settings.json` immediately matches the updated repo state. Idempotent: when no local-only keys
remain the command exits cleanly with a message and writes nothing.

Because the default destination (`shared/settings.base.json`) syncs to every host, the command
shows the destination and the keys it will promote and asks for confirmation before writing. Pass
`--yes` to skip the prompt; in a non-interactive shell the prompt cannot be answered, so the
command refuses to write unless `--yes` is given.

Credential- and secret-bearing keys (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
`otelHeadersHelper`, and `env`) are never promoted, so a secret placed in live settings cannot ride
into the shared repo.

| Flag        | Description                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host`    | Write into `hosts/<NOMAD_HOST>.json` instead of `shared/settings.base.json`. Use for host-specific values (absolute paths, machine-local model preferences). |
| `--dry-run` | Show the destination file and keys that would be written without changing anything.                                                                           |
| `--yes`, `-y` | Skip the confirmation prompt. Required when running without an interactive terminal.                                                                        |

## `redact`

`nomad redact <session-id> [--rule <id>] [--dry-run]`

Rewrite the secret span across a session's local source transcripts (the main transcript plus any
subagent transcripts under `<session-id>/`), backed up to `~/.cache/claude-nomad/backup/`. Refuses
to touch a session that was modified recently (potential active session). Safe to re-run. See
[Recovery flows](/claude-nomad/recovery/).

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

Idempotent: a fingerprint already present in `.gitleaksignore` is silently skipped. All inputs are
validated up front: a single invalid fingerprint (empty, containing a newline, or over 512
characters) aborts the whole command with exit 1 and writes nothing. No flags are accepted.

See [Recovery flows](/claude-nomad/recovery/) for the non-interactive push allow paths
(`nomad push --allow <rule>` and `nomad push --allow-all`), which record fingerprints AND
re-scan in a single step.

## `clean`

`nomad clean --backups [--older-than <dur>] [--keep <N>] [--dry-run]`

Delete old backup snapshots under `~/.cache/claude-nomad/backup/`. The `--backups` flag is required.
By default (no retention flag) removes snapshots older than 14 days. Always preview with `--dry-run`
first. See [Recovery flows](/claude-nomad/recovery/).

| Flag                | Description                                                                            |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--backups`         | Required: confirm backup pruning is the intended target.                              |
| `--older-than <dur>`| Delete snapshots older than this age (e.g. `7d`, `24h`). Default when omitted: 14 days. |
| `--keep <N>`        | Keep the N newest snapshots and delete the rest. Cannot be combined with `--older-than`. |
| `--dry-run`         | List the snapshots that would be removed without deleting.                             |

## `update`

`nomad update`

Update the `nomad` CLI binary from npm (`npm update -g claude-nomad`). Does NOT pull your sync data;
run `nomad pull` separately for that. See [Usage](/claude-nomad/usage/).

## `doctor`

`nomad doctor [--resume-cmd <id>] [--check-shared] [--check-schema] [--check-remote] [--verbose|--all|-v]`

Read-only health check. Each line carries a status glyph (`✓` pass, `✗` fail, `⚠︎` warn); any `✗`
sets `process.exitCode = 1` (`⚠︎` does not). Output ends with a **Summary** section that repeats
every warning and failure and closes with a one-line verdict (`✓ healthy`, or warning/failure
counts), so the last line always answers "am I healthy?". By default the report is compact: only the
version line, the Environment repo-state line, any section carrying a warning or failure (passing
rows removed), and the Summary are shown. Add `--verbose` (alias `--all`, `-v`) to print the full
per-check tree, including everything that passed. The exit code is identical in both modes. Includes a release-version staleness
check (an info line says when the latest version could not be determined, so a skipped check is
not mistaken for "current"), a Hook targets check that fails (`✗`, exit 1) when `settings.json`
references a hook command whose script under `~/.claude/` is missing on this host, a wedged-repo
check that fails (`✗`, exit 1) in two cases: the sync repo is stuck mid-rebase or mid-merge from
a previous failed pull, OR the git index has unmerged entries with no active rebase or merge (the
sibling state where the operation was torn down but the index was left stuck); both FAIL lines
carry a `nomad pull --force-remote` recovery hint. A separate `⚠︎` warn fires when an orphaned
autostash entry is found in `git stash list` (a stash entry left by a `--autostash` rebase that
was interrupted before completion); the warn is non-blocking and points at the `git stash pop`
or `git stash drop` runbook. Other `⚠︎`-only checks: gitleaks version drift; on a private GitHub
repo, re-enabled Actions; optional-dependency presence (`gh` and the curl-or-wget HTTP fetcher);
a backups-cache size/count nudge toward `nomad clean --backups`; an ESM/CommonJS hook-scope
mismatch; a Node-engine floor check; a hook command that runs a Node script under a synced
(symlinked) directory without `--preserve-symlinks-main`; and, when `NOMAD_HOST` is unset on a repo
that already configures other hosts, a hostname-derived host key that matches neither a
`hosts/<NOMAD_HOST>.json` override nor a path-map entry (the silent-misalignment nudge: per-host
settings and session sync key off this label, so set `NOMAD_HOST` to the label this host should use
when the warning fires; a single-host or fresh repo stays silent). The Environment section prints
an informational sync-modality row (`symlink (posix)` or `copy-sync (win32)`), and a CRLF-guard
check on every platform warns when the sync repo has no `.gitattributes` `* -text` line (the
wording names whether `core.autocrlf` is actively converting, explicitly `false` on this host, or
unset). On native Windows two further warn-only rows check long-path support (`git config
core.longpaths` and the OS `LongPathsEnabled` registry value), since deep encoded session paths
under `~/.claude/projects/` can exceed the legacy 260-character `MAX_PATH`; the
gitleaks-missing install hint also switches to `winget`/`scoop` there. The Path map section lists both
the
projects mapped for this host and any local project directories with no path-map entry (what
`nomad push` counts as "unmapped"; they are left alone in both directions).

| Flag                | Description                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--resume-cmd <id>` | Print a host-local `cd ... && claude --resume <id>` line for a session. See [Usage](/claude-nomad/usage/).                                                                                         |
| `--check-shared`    | Read-only gitleaks preflight: stages the session transcripts a `push` would publish into a temp tree and scans them, failing (`✗`, exit 1) per affected session. Skips with a `⚠︎` when gitleaks is not on PATH. Also runs two separate, WARN-only advisories (`⚠︎`, exit code untouched) over content already committed to the sync repo: `memory/*.md` files and `shared/skills/**` files, both pointing at the push-recovery Redact step; a latent memory or skill secret never fails this check. See [Recovery flows](/claude-nomad/recovery/). |
| `--check-schema`    | Read-only: fetches the live Claude Code settings schema and lists any `~/.claude/settings.json` key absent from it. Non-fatal and offline-tolerant: skips with a `⚠︎` when neither curl nor wget is available or the schema is unreachable. |
| `--check-remote`    | Read-only: verifies `origin/main` has `shared/` and a valid `path-map.json`. Reads the locally-cached remote-tracking ref (no network required when the ref is already cached); skips with a `⚠︎` when the ref is unavailable or `git` is not on PATH. Non-fatal in all cases. |
| `--verbose`, `--all`, `-v` | Print the full per-check tree, including passing checks. Without it, `doctor` shows only checks that need action plus the Summary verdict. `--check-shared` / `--check-schema` / `--check-remote` sections always render in full when their flag is set, in either mode. |

### Output details

The version-check emits a warning when the local install is behind the latest upstream release,
and a pass line when current. It silently skips on network failures.

The Hook targets check reads the live `~/.claude/settings.json` `hooks` block and fails (`✗`,
exit 1) when a hook command points at a script under `~/.claude/` that is missing on this host
(the freshly-configured-host symptom that motivated syncing `hooks/`). It deliberately skips any
command it cannot resolve to a `~/.claude/` path (bare binaries like `jq`, unresolved env vars),
so it never false-fails on a command that does not reference a local script.

The preserve-symlinks check (`⚠︎`-only) catches a hook that would crash on every session start:
when a hook command runs a Node script that lives under one of the directories claude-nomad
symlinks into `~/.claude/`, Node resolves the script into the sync repo, and any
`require('../...')` of a `~/.claude/` neighbor breaks with `MODULE_NOT_FOUND` (see the
[FAQ](/claude-nomad/faq/) for a real-world walkthrough). The warning line names the fix: add
`--preserve-symlinks-main` to the hook command in `shared/settings.base.json`. It is deliberately
conservative: only clear `node <script-under-symlinked-dir>` shapes are flagged, and a bounded,
never-executed peek at the script's first 64 KB suppresses the warning when the script's relative
requires all resolve (or it has none), so self-contained hooks stay silent.

Two further warning-only drift checks run in `nomad doctor`. The gitleaks version-drift line fires
when the local gitleaks major.minor differs from the CI-pinned `GITLEAKS_PINNED_VERSION` (gitleaks
rule and allowlist behavior tracks the minor line, so a patch-only difference stays as a pass),
and is silent when gitleaks is not on PATH. The Actions-drift line (carrying a
`gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false` remediation hint) fires
when origin is a private GitHub repo that is gh-authed with Actions re-enabled, complementing
the auto-disable that runs on `nomad init` (see [Quickstart](/claude-nomad/quickstart/)); it is silent on every
prerequisite miss (non-GitHub origin, `gh` unauthed, public repo, or Actions already off).

The settings merge-drift check (`⚠︎`-only, never exit 1) runs in the Settings section of
`nomad doctor` immediately after the host-overrides row. It recomputes the same
`deepMerge(shared/settings.base.json, hosts/<NOMAD_HOST>.json)` that `nomad pull` would write,
then deep-compares the result against `~/.claude/settings.json`. A `⚠︎` warning fires when
merged keys are missing from the live file, the signature of an external
writer (for example a Claude Code onboarding flow) silently clobbering `settings.json` and
dropping managed keys; the fix is `nomad pull`. A second warning fires when a key is present on
both sides but its value diverged: this is genuinely ambiguous (the repo or your local file could
be the newer one), so the hint points at `nomad diff` to inspect, and notes that `nomad pull` would
overwrite local with the repo while editing the base/host file keeps the local value. The
comparison normalizes node launcher paths first, so a hook that differs only by a bare `node`
versus an absolute `/.../bin/node` (host-specific churn an installer writes) does not register as
drift. A separate info line lists local-only keys
absent from the merge as promotion candidates for `shared/settings.base.json` or
`hosts/<NOMAD_HOST>.json`, since those are typically transient state written between pulls (for
example notification toggles), not an error; when this host has no `hosts/<NOMAD_HOST>.json` at
all, that info line is withheld because the host-overrides row above it already flags the same
keys as a failure. A `⚠︎` warning also fires when `hosts/<NOMAD_HOST>.json` exists but does not
parse, since `nomad pull` would stop on that file. The check reports key names only and never
leaks values. It skips with a `ℹ︎` when `settings.json` is absent or when
`shared/settings.base.json` is absent or unparseable; a malformed `settings.json` is skipped
silently, since doctor's settings load already fails (`✗`, exit 1) on the same file.

Also in the Settings section, a one-time info line (never a warning, never exit 1) appears while the
committed `shared/settings.base.json` still holds gsd-owned hook entries (commands whose script
basename starts with `gsd-`). GSD manages those entries per host, so nomad filters them out of the
generated `settings.json` on pull and rewrites the committed base to drop them on the next real
`nomad push` (backed up first, idempotent, never on pull or `--dry-run`). The note resolves itself
once the base is clean. See [GSD-aware sync](/claude-nomad/gsd-aware-sync/) for the full picture.

## Global flags

`nomad --version`

Print the installed CLI version as bare semver to stdout; exits 0. Used by the npm-publish smoke
test and useful for ad-hoc upgrade checks.

## Exit codes

Every `nomad` subcommand exits with one of a small set of codes, so a script or cron wrapper can
branch on `$?` without parsing stderr text.

| Code | Name            | Meaning                                                                                                               |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0    | Success         | Completed successfully.                                                                                                 |
| 1    | Generic failure | Unclassified failure; the default for any error not covered below.                                                     |
| 2    | Usage           | Bad argv: an unknown subcommand, an unknown flag, or a malformed flag value.                                            |
| 4    | Conflict        | The sync repo is wedged (e.g. an unresolved rebase) and needs manual git resolution. |
| 5    | Leak blocked    | gitleaks confirmed a secret in the staged tree and the push was aborted.                                               |

A run skipped because another nomad process already holds the lock also exits 0: this is an
intentional no-op skip, not a failure, so a backgrounded shell-rc or cron invocation never raises a
false alarm from a concurrent run. Value `3` is reserved for future use.

## Crash reports

When `nomad` hits an unexpected bug it prints a short "this looks like a bug" banner (with a link to
the issue tracker) instead of a raw stack trace, and writes a bounded, redacted report to
`~/.cache/claude-nomad/crash/`. The exit code contract is unchanged: an unexpected crash exits `1`,
a documented failure keeps its own code.

- **Local only, never uploaded.** The report is written owner-readable-only under your cache dir and
  nothing is transmitted anywhere; you choose whether to attach it to an issue.
- **Two-layer redaction.** A structural scrub (home directory to `~`, hostname to a placeholder)
  always runs, followed by a best-effort gitleaks secret scan, the same redaction nomad uses for
  session transcripts.
- **Fail-safe without gitleaks.** If gitleaks is absent, the structural scrub still applies and the
  report is still written, with a note that the secret scan did not run, so review it before sharing
  publicly.
- **Bounded contents.** Only the nomad version, the command you ran (bounded, including any flag
  values), the error name and message, a trimmed stack, the platform, the Node.js version, and a
  timestamp. No environment dump, no file contents.
- **Self-pruning.** The crash directory keeps only the most recent reports and prunes older ones
  automatically. There is intentionally no `nomad clean` flag for it.
