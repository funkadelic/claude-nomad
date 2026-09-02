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
line endings between hosts (what would otherwise happen on a native Windows checkout with the common
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

On native Windows, where shared config is a real copy rather than a symlink, pull first mirrors
those copies into the repo, before the rebase, and reports what it took in a leading `Symlinks`
section (one `captured  <local> -> <repo>` row per name), so the copy is visible rather than
silent. Without that step the rebase-then-overlay sequence would overwrite an edit you had not
published yet. That mirror skips your Claude login and credential files, your per-host settings,
your local history and stats cache, and any file that looks like a credential by name (a `.env`, a
private key, a `.netrc`); see `src/config.never-sync.ts` for the exact lists. An ordinary directory
of your own inside a shared name is carried, not skipped. A name whose `shared/<name>` counterpart
is in the repo but leads nowhere, or cannot be read at all, is left alone too, and the pull warns
naming it, so a local edit does not quietly stop being captured; the `nomad diff` and `--dry-run`
previews say the same in read-only wording. A counterpart that leads nowhere asks you to remove the
entry from the sync repo or restore what it points at, by hand; one that could not be read asks you
to check its permissions there instead, because nothing established where it leads. If a
skipped path is already sitting in the sync repo working tree, pull removes it when git does not
track it (snapshotting it to the backup dir first, unless it is a symlink whose target is already
gone and there is no content to save) and otherwise leaves it exactly as it found it, warning with
the file name and the git command that
clears it. Neither case fails the pull. The same pre-rebase step also removes a file
you deleted from a shared directory from the repo, the same as deleting inside a symlinked directory
already removes it on macOS or Linux, and the pull names that removal too, as a
`removed  <repo> (gone from <local>)` row in the same `Symlinks` section, right after any captured
rows; the removal is left uncommitted (it publishes on your next
push, through the same secret scan as everything else) and the repo copy is snapshotted to the
backup dir first, gated on a per-host record of what this machine last had, so a repo file this
machine has never synced is never touched. That record is also why the first pull after a host
upgrades to this version is an exception: there is nothing to compare against yet, so a deletion
made before that pull is restored once and has to be repeated. On macOS and Linux the symlink
already makes a local edit (and a local deletion) an uncommitted change in the sync repo, so the
step is a no-op there and both platforms behave the same way. It is also skipped under `--dry-run`,
which writes nothing to `~/.claude/` or to your shared config (though it still runs the
`git pull --rebase` that refreshes the sync repo, so the preview reflects the remote), and under
`--force-remote`, but only when that flag actually recovers a repo stuck mid-rebase or mid-merge:
that recovery resets the sync repo to `origin/main`, and re-staging local copies right after the
reset would immediately undo it. On a repo that is not wedged, `--force-remote` no longer skips the
mirror, so an unpublished edit is captured exactly as on a plain pull, and the command prints an
info line reporting there was nothing to recover before continuing. When the mirror is skipped
because recovery genuinely ran, the pull also prints a warning naming how many shared names it
restored from the repo copy, and where their previous host copies were saved. If the mirror or
removal step itself fails (an antivirus lock, or a path over the native Windows length limit), the
pull warns and carries on instead of aborting, so you can still fetch; your unpublished edit or
deletion stays pending on the host. A file you had just created inside a shared directory is the
exception: the repo-to-local overlay later in the same pull removes it from `~/.claude/`, after
snapshotting it to the backup dir, so recover it from there and pull again. Separately, if a file
you created inside a shared directory has the same name as one the incoming update adds, the pull
stops before applying anything and, underneath git's own untracked-file error, prints the file under
`~/.claude/` to move or rename plus the two ways to finish; nothing is lost either way, since your
file is untouched, the update simply has not landed yet, and the copy nomad had made in the sync
repo is cleaned up for you.

| Flag             | Description                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`      | Network-aware preview: acquire lock + `git pull --rebase`, print planned changes (symlink moves, `settings.json` diff, transcript overwrites, an `Extras` section listing every `<logical>/<dirname>` a wet pull would copy including extras with no local copy yet, a count of retained local-only sessions, and any extras-divergence warning). On native Windows the same tree also shows every shared-config capture the pre-rebase mirror would perform and every removal the same step would make in the repo, so the preview matches the wet run in both directions. Writes nothing to `~/.claude/`, but the `git pull --rebase` above updates the sync repo (`~/claude-nomad/`) first so the preview reflects the remote.                                                                            |
| `--force-remote` | Recover from a wedged sync repo. Two recovery paths depending on state: (1) stuck mid-rebase or mid-merge: abort the in-progress operation, park stranded commits on `nomad/stranded-<ts>`, reset to `origin/main`, and re-pull; refuses if stranded or dirty tracked changes touch synced config (shared/, hosts/, path-map.json). (2) unmerged index with no active rebase or merge: clear the stuck index via `git reset --mixed HEAD` (preserves working-tree edits), surface any orphaned autostash entry with a hint, and re-pull; no abort, no park step. On a repo that is not wedged, prints an info line reporting there is nothing to recover and continues as a normal pull (exit status success); when the check for a stuck index cannot run at all (git missing, or the index lock still held when the check times out), it reports that it could not determine whether the repo is wedged instead of claiming the repo is clean, and continues the same way. On native Windows, when recovery genuinely runs via path (1), the pre-pull shared-config mirror is skipped because the reset to `origin/main` would otherwise be undone immediately after; the pull warns, naming how many shared names were restored from the repo copy and the backup directory holding their previous host copies. Cannot combine with `--dry-run` (it performs mutations incompatible with preview mode). |

## `diff`

`nomad diff`

Offline, lockless twin of `pull --dry-run`. No network, no lock. Works against the current local
repo state. The `settings.json` diff filters gsd-owned hook entries from both sides before
comparing, so GSD's per-session hook self-heal does not show up as a phantom `hooks` change; the
preview reflects what a real pull would write. Also renders the same `Extras` section as
`pull --dry-run`, listing every `<logical>/<dirname>` a pull would copy, including extras with no
local copy yet. On native Windows it shows the same shared-config capture and removal rows
`pull --dry-run` shows, reading the host-local record those rows are gated on without ever writing
to it, so `nomad diff` stays fully read-only.

## `push`

`nomad push [--dry-run] [--full-scan] [--redact-all] [--allow <rule>] [--allow-all]`

Export local sessions and opted-in per-project extras to logical names, commit
(`chore: sync from <NOMAD_HOST>`), push. Steady-state pushes scan only the
transcripts that changed since the last successful push (incremental); a cold
start, a gitleaks version change, a gitleaks config change, or `--full-scan`
forces a full rescan of all transcripts.

On native Windows, before any of that, push also carries your local edits back into the sync repo
for names the repo already shares, the same as `nomad pull` does before it fetches. A directory the
repo does not carry yet stays on this machine until you run `nomad adopt <name>`, the same as on
macOS, Linux, and WSL2: publishing a directory to every other host is something you ask for, not a
side effect of the next push. A name you have already shared is unaffected and keeps publishing your
edits on every push.

If a name you have already shared ends up with a broken pointer in the sync repo instead, for
example because a machine that shared it no longer has the original, push skips writing through it
exactly as it did before, but now also prints a warning naming the entry so your local edit does not
silently stop reaching the repo. Push does not repair the broken pointer for you: remove it from the
sync repo, or restore what it pointed at, by hand. An entry push could not read at all is skipped
and named the same way, but the warning points at its permissions in the sync repo rather than at a
broken pointer, because nothing checked where that entry leads. Neither warning fails the push.

| Flag               | Description                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`        | Run pre-push safety checks (gitleaks probe, rebase, remap preview, gitlink scan, allow-list) and a read-only gitleaks leak preview over a throwaway temp copy of the sessions, extras, and non-gsd user skills this host would stage. Exits with code 5 if a leak is found, or if the staged tree cannot be scanned cleanly (the scan ran but produced no parseable report); both fail closed with the same leak-blocked code a real push uses, so a scripted `$? == 5` pre-flight buckets them the same way. Only a scan that could not run at all (gitleaks or git missing) exits 1. Writes nothing to `~/.claude/` and commits/pushes nothing, but the rebase above updates the sync repo (`~/claude-nomad/`) first.    |
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

On native Windows the pull half also mirrors your shared-config copies into the repo before it
fetches, and removes a file you deleted from a shared directory from the repo the same way (see
[`pull`](#pull) below), so pulling first cannot overwrite an edit, or resurrect a deletion, you have
not published yet. Under `--dry-run` that mirror and removal pass is skipped along with every other
write.

Output is compact by default, matching `nomad doctor`: a run prints its `sync on host=<HOST>`
header, then a single Sync summary composed from the run's outcome, not the full status tree.
Pass `--verbose` (or `--all` / `-v`) to also print the full merged status tree (on native Windows a
leading `Symlinks` section naming what the pre-fetch mirror captured and what it removed, then
Settings, Global config, Sessions, Extras, and Leak scan, as applicable) before the summary, the
same tree every `nomad sync` run used to print unconditionally.

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

`--dry-run` previews both halves: the pull preview renders first, then a one-line note that the
push preview below is computed against pre-pull state (a real sync runs the push half after the
pull half has already applied, so its staging set can differ slightly), then the push preview.
Both previews are the same ones `nomad pull --dry-run` and `nomad push --dry-run` render, so the
pull preview also surfaces the wedged-repo check and the diverged-extras warnings.

What this means for you: a dry run never touches `~/.claude/` and never commits or pushes
anything, but it is not a completely offline, zero-effect command. Like `nomad pull --dry-run`
and `nomad push --dry-run`, it contacts the remote and brings your sync repo
(`~/claude-nomad/`) up to date with it first. That is deliberate: a preview computed before
fetching would describe the state you are about to leave rather than the changes a real sync
would apply.

`nomad push` and `nomad pull` remain available as lower-level commands for cases `sync` does not
cover, such as `--force-remote` wedge recovery or the non-interactive leak-resolution flags
(`--redact-all`, `--allow`, `--allow-all`, `--full-scan`).

| Flag                     | Description                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `--dry-run`              | Stack the pull preview then the push preview; acquires the lock. Writes nothing to `~/.claude/` and commits/pushes nothing, but both halves fetch and rebase the sync repo first so each preview reflects the remote (same contract as `pull --dry-run` and `push --dry-run`). |
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
editor, so it never writes `path-map.json` itself. A credential-shaped `<name>` is refused
outright, before the membership check and before `--dry-run` takes effect: `.env`, `id_rsa`,
`credentials`, `*.pem`, `*.key` and similar shapes stop the command with an error and exit code 1,
since adopting one would move a secret into the sync repo. On native Windows adopt recreates the
name as a real copy instead of a symlink (the win32 copy-sync modality). There, a name whose
`shared/<name>` counterpart already exists and resolves to something real is reported as already
adopted and skipped (with a `nomad pull` hint to refresh the local copy), where macOS, Linux, and
WSL2 would refuse with a would-clobber error. If that counterpart is there but does not lead to
anything usable, either because it points at content another host shared that never reached this
one, or because it could not be read at all, adopt now stops with an error naming the entry and
exits 1, rather than the older behavior of reporting it already adopted and pointing you at a
`nomad pull` that could not have fixed that state either. If the entry does not resolve, remove it
from the sync repo or restore what it points at, then run `nomad adopt <name>` again. If it could
not be read, check its permissions in the sync repo before you rerun the command. On macOS, Linux,
and WSL2, the would-clobber refusal now says which of those three it found, so it never claims
there is content in the way when all it saw was a pointer leading nowhere, or a path it could not
read. The same state is also called out, on every platform, when your local `~/.claude/<name>` is
already a symlink into the sync repo: adopt used to report a plain already-adopted success there
too, and now prints a warning saying the link is broken, or, when the sync repo entry could not be
read at all, that it could not tell whether the link works. A symlink with no `shared/<name>` in the
repo behind it at all is called out the same way, since a link the sync repo has no counterpart for
is not adopted either: remove `~/.claude/<name>` and run adopt again, or run `nomad pull` if another
machine already shares the name. It still exits 0 in all three cases, since it is reporting rather
than writing and nothing is silently lost. The warning goes to standard error with the same warning
marker `nomad push` and `nomad doctor` use for that state, so all three surfaces are greppable the
same way. If that copy cannot be written, because another program has the path open or its
permissions block it, adopt stops with an error naming the path and exits 1. The content itself is
not lost: it is already in `shared/<name>`, and staged unless the same error also reports that
staging failed. Run `nomad pull` to recreate the local copy before your next `nomad push`, because a
push copies the local name back over `shared/<name>` first, so publishing while the local copy is
missing is what would undo the adopt. If the error says a partial copy is still at the path, hold
off on `nomad sync` too, since it pushes in the same run: pull on its own first, and check it does
not warn about that name again, because a pull that still cannot read the path warns and carries on
rather than stopping.

Three earlier steps can fail the same way. The first is the snapshot adopt takes before it moves
anything, which fails when the backup cache cannot be written. Adopt stops there and exits 1:
nothing has been removed from `~/.claude/` and nothing has been written to the sync repo. A partial
snapshot may be left behind in the backup cache, which is harmless, and `nomad clean --backups`
prunes it.

If the copy INTO `shared/<name>` fails, nothing has been removed from `~/.claude/`: adopt clears
whatever partial copy reached the repo and asks you to run the command again once the path is
readable. Should it report a partial `shared/<name>` it could not clear, remove that one yourself
before re-running. On macOS, Linux, and WSL2 adopt would otherwise turn the re-run away with the
would-clobber error. On native Windows removing it matters more, because there a name whose
`shared/<name>` exists is reported as already adopted, so the re-run would claim success over a
half-copied fragment, and the `nomad pull` that reply suggests would copy that fragment over the
local directory this failure left whole.

If the copy succeeds but the original cannot be removed, the answer depends on the platform. On
native Windows a real local copy sitting beside a populated `shared/<name>` is exactly what an
adopted name looks like, so adopt warns, refreshes the local copy from the repo, and finishes
normally. On macOS, Linux, and WSL2 the same leftover is a real directory where the symlink
belongs, so adopt stops with an error and exits 1, having staged `shared/<name>` anyway: run
`nomad pull`, which backs that directory up and replaces it with the symlink.

Before touching anything, adopt checks the whole `~/.claude/<name>` tree against two separate lists,
both in `src/config.never-sync.ts`. The first is a list of exact names, `ALWAYS_NEVER_SYNC`, and it
is narrower than you might expect: it holds only the credential and per-host settings files
(`.claude.json`, `.credentials.json`, `settings.local.json`, `history.jsonl`, `stats-cache.json`).
Your own folders named `plans`, `tasks`, `cache`, `sessions` or `todos` inside the directory you are
adopting are carried into the sync repo like anything else, because you asked for that directory to
be shared. The second is a list of credential filename shapes, `SECRET_FILE_PATTERNS`, which catches
`.env` and `.env.local`, `id_rsa`, `credentials`, `.netrc`, `.npmrc`, and anything ending in
`.pem`, `.key`, `.p12` or `.pfx`. Neither list looks inside a file, so a directory of your own that
happens to be spelled exactly like a credential name is refused too: that is a name collision, not a
secret it found. Both kinds are exactly what the sync repo refuses to publish, so moving them into
`shared/<name>` would only defer the failure to your next `nomad push`.

The two lists answer two different questions, and adopt uses both. Is `<name>` itself, the directory
you are pointing adopt at, safe to share at all? That is checked against the full set in
`src/config.never-sync.ts`, so `nomad adopt sessions` or `nomad adopt cache` is still refused as a
NAME, unchanged by any of this. Is the CONTENT inside a directory you have already chosen to share
safe to carry? That is the narrower check above, and it is what changed: a `sessions/` or `plans/`
folder inside your own `my-tools/` now adopts along with everything else.

If the content check finds anything, adopt stops before the backup and before anything is copied or
moved, so nothing on your machine or in the repo has changed; the error lists every offending path
relative to `~/.claude/<name>/`, says which of the two lists caught it, and exits 1. `--dry-run`
answers exactly the same way, with the same exit code, rather than previewing a move it would
refuse. To clear it, move those paths out of `~/.claude/<name>/` and run `nomad adopt <name>` again.
Renaming works too for a name collision, since the spelling is the whole of the match and the error
quotes the name to rename away from. It does not work for a credential filename shape, where the
extension or the whole filename is what matched, so a new name in the same shape is refused
identically.

| Flag        | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `--dry-run` | Preview the planned backup, move, and `git add` without touching the filesystem or the git index. |

## `eject`

`nomad eject [--dry-run]`

Replace every managed `~/.claude/` symlink with a real dereferenced copy so your setup keeps
working after you delete the `~/claude-nomad/` checkout and uninstall the CLI. The set of managed
names is the union of `SHARED_LINKS` and validated `sharedDirs` entries that `nomad pull` manages
(the authoritative list is `allSharedLinks` in `src/config.ts`), widened with anything an older
version of nomad already linked under a looser rule. That widening is deliberate: eject
materializes what this host already has, so a name sync now refuses is still dereferenced into a
real copy rather than left as a symlink into a checkout you are about to delete. Names that are
already real files or directories are reported as skipped and left unchanged; absent names are also
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
By default (no retention flag) removes snapshots older than 14 days. A snapshot that holds nothing
is removed in every mode, whatever its age and whatever `--keep` says, since there is no content in
it to protect. Always preview with `--dry-run` first. See
[Recovery flows](/claude-nomad/recovery/).

| Flag                | Description                                                                            |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--backups`         | Required: confirm backup pruning is the intended target.                              |
| `--older-than <dur>`| Delete snapshots older than this age (e.g. `7d`, `24h`). Default when omitted: 14 days. |
| `--keep <N>`        | Keep the N newest snapshots that hold something and delete the rest. Cannot be combined with `--older-than`. |
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
per-check tree, including everything that passed. The exit code is identical in both modes. Includes
a release-version staleness check (an info line says when the latest version could not be
determined, so a skipped check is not mistaken for "current"), a Hook targets check that fails (`✗`,
exit 1) when `settings.json` references a hook command whose script under `~/.claude/` is missing on
this host, a wedged-repo check that fails (`✗`, exit 1) in two cases: the sync repo is stuck
mid-rebase or mid-merge from a previous failed pull, OR the git index has unmerged entries with no
active rebase or merge (the sibling state where the operation was torn down but the index was left
stuck); both FAIL lines carry a `nomad pull --force-remote` recovery hint. A separate `⚠︎` warn
fires when an orphaned autostash entry is found in `git stash list` (a stash entry left by a
`--autostash` rebase that was interrupted before completion); the warn is non-blocking and points at
the `git stash pop` or `git stash drop` runbook. Other `⚠︎`-only checks: gitleaks version drift; on
a private GitHub repo, re-enabled Actions; optional-dependency presence (`gh` and the curl-or-wget
HTTP fetcher); a backups-cache size/count nudge toward `nomad clean --backups`; an ESM/CommonJS
hook-scope mismatch; a Node-engine floor check; a hook command that runs a Node script under a
synced (symlinked) directory without `--preserve-symlinks-main`; and, when `NOMAD_HOST` is unset on
a repo that already configures other hosts, a hostname-derived host key that matches neither a
`hosts/<NOMAD_HOST>.json` override nor a path-map entry (the silent-misalignment nudge: per-host
settings and session sync key off this label, so set `NOMAD_HOST` to the label this host should use
when the warning fires; a single-host or fresh repo stays silent). The Environment section prints an
informational sync-modality row (`symlink (posix)` or `copy-sync`). On native Windows that row also
names when a local edit reaches the repo (the next pull or push, since the host-side and repo-side
files are distinct there) and is kept in the default compact view; the posix row stays verbose-only.
On native Windows, the per-name shared-link row (the same one covering `CLAUDE.md`, `commands/`,
`rules/`, and any `sharedDirs` entries) also byte-compares the real copy against its `shared/`
counterpart and warns (`⚠︎`, exit code untouched) with the diverging files listed when it has
drifted, instead of reporting it healthy on presence alone; a matching copy still reads `✓`. Paths
the mirror will never sync (now the narrower credential and per-host-settings floor) are thrown out
of that comparison rather than reported as drift, since no command could reconcile them; when any
were excluded, the passing row carries a dim `(N never-synced path(s) not compared)` note under
`--verbose`. On native Windows, a real local copy the sync repo does not carry (never published,
since `nomad push` no longer creates a repo counterpart on its own) gets its own info row naming
`nomad adopt <name>`; it never fails the check and, like every other informational Links row, it is
stripped from the default compact view and shown under `--verbose`. On native Windows, when a real
local copy sits beside a `shared/<name>` counterpart that leads nowhere, doctor now warns and names
the broken repo pointer, instead of the older behavior of reporting the name as never published and
pointing you at `nomad adopt <name>`, a command that now refuses that exact state. On every
platform, when your local entry is missing entirely, or your local symlink into the sync repo is
itself broken, and the repo's own `shared/<name>` pointer also leads nowhere, doctor now warns that
`shared/<name>` does not resolve and that there is nothing to restore from either side. This
replaces two older lines that no longer fit that state: one saying the name was simply never shared,
and one saying the dangling local symlink was stale and safe to remove, neither of which named the
real problem, that the repo's own copy is unusable too. When the repo's entry cannot be read at all,
rather than pointing nowhere, doctor now says exactly that and points you at its permissions, where
it used to report the name as never shared, on a quiet informational line the default view hides. On
macOS, Linux, and WSL2, when a real file or directory sits at `~/.claude/<name>` where a link into
the sync repo belongs, the failing row only tells you to run `nomad adopt <name>` when that command
could actually help. When the sync repo entry is unusable it names the entry to clear up first,
since adopt would refuse. When the sync repo entry already holds content, adopt refuses for a
different and deliberate reason, that it will not choose between two copies of the name that have
drifted apart on different machines, so the row says so and names both ways out: compare the two,
then either remove the local copy and run `nomad pull`, or remove the repo entry and run `nomad
adopt <name>`. Either direction discards one copy, which is why nothing does it for you. Native
Windows reports the same situation through its own copy-model rows, which list the files that
differ. All of these are failing rows, so they do set the exit code; the warning rows above leave it
untouched, so a script that only checks the exit code should still read those lines. A CRLF-guard
check on every platform warns when the sync repo has no `.gitattributes` `* -text` line (the wording
names whether `core.autocrlf` is actively converting, explicitly `false` on this host, or unset). On
native Windows two further warn-only rows check long-path support (`git config core.longpaths` and
the OS `LongPathsEnabled` registry value), since deep encoded session paths under
`~/.claude/projects/` can exceed the legacy 260-character `MAX_PATH`; the gitleaks-missing install
hint also switches to `winget`/`scoop` there. The Path map section lists both the projects mapped
for this host and any local project directories with no path-map entry (what `nomad push` counts as
"unmapped"; they are left alone in both directions).

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
| 130  | Interrupted     | You pressed Ctrl+C at an interactive prompt, so nomad stopped without finishing.                                        |

A run skipped because another nomad process already holds the lock also exits 0: this is an
intentional no-op skip, not a failure, so a backgrounded shell-rc or cron invocation never raises a
false alarm from a concurrent run. Value `3` is reserved for future use.

## Crash reports

When `nomad` hits an unexpected bug it prints a short "this looks like a bug" banner (with a link to
the issue tracker) instead of a raw stack trace, and writes a bounded, redacted report to
`~/.cache/claude-nomad/crash/`. The exit code contract is unchanged: an unexpected crash exits `1`,
a documented failure keeps its own code. A prompt you cancel yourself is not a crash: it exits `130`
and writes no report.

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
