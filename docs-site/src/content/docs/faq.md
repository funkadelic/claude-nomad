---
title: FAQ
description: Common questions about day-to-day claude-nomad workflows.
---

## I edited ~/.claude/settings.json and my change vanished after a pull. Why?

Because that file is **generated**, not synced. Every `nomad pull` rebuilds it by merging
`shared/settings.base.json` with `hosts/<NOMAD_HOST>.json` from your sync repo, so anything you
hand-edit into `~/.claude/settings.json` on a synced host is overwritten by the next pull.

Make the edit in the sync repo instead:

- Want it on **every host**? Edit `shared/settings.base.json`.
- Want it on **this host only**? Edit `hosts/<NOMAD_HOST>.json`.

Then `nomad push` from the host you edited on (or just commit and push the repo) and `nomad pull`
everywhere else. Truly host-local settings that should never sync can also live in
`~/.claude/settings.local.json`, which claude-nomad never touches.

## How do I set a per-host setting, like a different model or an env var?

Put it in `hosts/<NOMAD_HOST>.json` in your sync repo. On every pull, that file is deep-merged on
top of `shared/settings.base.json`, with these rules:

- **Scalars override**: `"model": "opus"` in the host file beats the base value.
- **Objects merge recursively**: you can override one key inside `env` without redeclaring the
  rest.
- **Arrays replace wholesale**: a host-file array swaps out the base array, it does not append.
- **`null` is a valid override**: use it to explicitly blank out a base value on one host.

## Why isn't my session showing up on the other host?

Almost always: the project is not in `path-map.json`. Only projects listed there sync; everything
else is left alone in both directions, and push/pull fold those into a single info row like
`ℹ︎ 4 not in path-map`. Run `nomad doctor` to list the unmapped projects by name, then add the
project to `path-map.json` with its absolute path on each host (see
[How it works](/claude-nomad/how-it-works/) for the format), push, and pull on the other host.

## `nomad doctor` lists "unmapped local projects" I don't recognize. Are they broken?

No, they are normal. In Claude Code, a **"project" is just any directory you have launched
`claude` from**. The first time you run a session in a folder, Claude Code creates a matching
directory under `~/.claude/projects/` and stores that session's transcripts (the `.jsonl` files)
there. So the unmapped list is simply every working directory you have ever started a session in
that is not listed in your `path-map.json`, often throwaway ones like your home folder, a repo's
subdirectory, or a parent directory you happened to `cd` into once.

They are real (each holds actual session transcripts), not corruption and not a sync error.
claude-nomad deliberately leaves unmapped projects alone in both directions: they are never pushed
and never pulled, so they only ever exist on the machine that created them.

You do not have to do anything. Two options if you want to tidy up:

- **Want a project's sessions to follow you across hosts?** Add it to `path-map.json` (see
  [Why isn't my session showing up on the other host?](#why-isnt-my-session-showing-up-on-the-other-host)).
- **It is throwaway?** Delete its folder under `~/.claude/projects/`. That removes the local
  transcripts for that directory only; nothing synced is touched, and your mapped projects are
  unaffected.

## What never leaves my machine?

Credentials and ephemeral state are excluded by a hard-coded block list: OAuth tokens and MCP
state (`.claude.json`, `.credentials.json`), your prompt history (`history.jsonl`), per-host
overrides (`settings.local.json`), and runtime dirs like `todos/`, `shell-snapshots/`, caches,
and telemetry. The authoritative list is the `NEVER_SYNC` set in `src/config.ts`, and the
sensitive subset stays blocked even inside an opted-in extras directory. On top of that, only an
explicit allow-list of paths can be pushed at all, and everything that is pushed gets scanned by
gitleaks first. See [Security](/claude-nomad/security/) for the full trust model.

## Push says gitleaks found a secret. Now what?

Three exits, depending on what the finding is:

- **Real secret in a transcript you want to keep**: `nomad redact <session-id>` (or answer
  `Redact` in the interactive menu) rewrites the secret in place, locally, then push again.
- **False positive**: `nomad push --allow <rule>` or `nomad allow <fingerprint>` records it in
  `.gitleaksignore` so it stops blocking.
- **Session you do not need to sync**: `nomad drop-session <id>` unstages it from the sync repo
  while leaving the local file intact for `claude --resume`.

The full decision tree, including non-interactive CI paths, is in
[Recovery flows](/claude-nomad/recovery/).

## What is the difference between nomad diff and nomad pull --dry-run?

Both preview what a pull would change, but `nomad diff` is **offline and lockless**: it does not
take the sync lock and does not contact the remote, so it shows what a pull would do against the
repo state you already have checked out. `nomad pull --dry-run` does the network round-trip
first, so it shows what the next real pull would actually apply. Use `diff` for a quick local
look, `--dry-run` for the authoritative preview.

One thing neither preview writes: your `skills/` directory. Skills are copy-synced only on a
real (non-dry-run) pull, so `--dry-run` never touches `~/.claude/skills`. The preview still
reports every other planned change (symlink moves, `settings.json` diff, transcript overwrites).

## Backups are piling up in ~/.cache/claude-nomad. Is that a problem?

Every pull and push snapshots what it is about to overwrite into
`~/.cache/claude-nomad/backup/<timestamp>/`, and nothing deletes those automatically. `nomad
doctor` warns once the pile passes 20 directories or 200 MB. Prune with:

```bash
$ nomad clean --backups                 # delete backups older than 14 days
$ nomad clean --backups --keep 5        # or: keep only the 5 newest
$ nomad clean --backups --dry-run       # preview either mode first
```

## Every pull fails with "Pulling is not possible because you have unmerged files"

```text
error: Pulling is not possible because you have unmerged files.
fatal: Exiting because of an unresolved conflict.
✗  git pull --rebase failed
```

There are two distinct states that produce this error. Check which one you are in before
running any recovery command.

### State 1: stuck mid-rebase or mid-merge

A previous pull's rebase (or merge) hit a conflict and was never resolved. The sync repo has an
in-progress operation that git is waiting on: `.git/rebase-merge/`, `.git/rebase-apply/`, or
`.git/MERGE_HEAD` is present inside `~/claude-nomad/`.

You can confirm this with:

```bash
$ ls ~/claude-nomad/.git/rebase-merge 2>/dev/null && echo "mid-rebase" || \
  ls ~/claude-nomad/.git/MERGE_HEAD  2>/dev/null && echo "mid-merge"
```

**Automated recovery (recommended):** `nomad pull --force-remote` automates the sequence below.
It aborts the in-progress rebase or merge, safety-diffs stranded commits and dirty tracked
changes against `origin/main`, parks stranded commits on a `nomad/stranded-<ts>` branch, resets
hard to `origin/main`, and re-pulls. If any stranded or dirty tracked changes touch synced config
(shared/, hosts/, path-map.json), it refuses and lists the at-risk paths so nothing config-related
is silently discarded. The parking branch stays in the repo as a recoverable ref.

**Manual fallback** (use if `--force-remote` refuses due to synced-config changes):

```bash
$ cd ~/claude-nomad
$ git rebase --abort        # or: git merge --abort, if it was a merge

# Safety check before discarding local state: what would be thrown away?
$ git log --oneline origin/main..HEAD     # stranded local commits, if any
$ git diff origin/main --stat             # uncommitted divergence

# If nothing above touches config you care about (shared/, hosts/, path-map.json):
$ git reset --hard origin/main
$ nomad pull
```

If the safety check shows local-only commits that DO touch synced config, cherry-pick or copy
those changes out before the `reset --hard`; they exist nowhere else. When in doubt, the repo is
plain git, so anything discarded is still in `git reflog` until git prunes it.

### State 2: unmerged index with no active operation

The rebase or merge was torn down (the marker files are gone) but the git index still holds
unmerged entries from the conflict (stage-2 and stage-3 versions of the same file). There is
nothing to abort. Running `git rebase --abort` will say "No rebase in progress" and do nothing.
This is the sibling state to State 1 and is just as stuck.

You can confirm this with:

```bash
$ cd ~/claude-nomad
$ git diff --diff-filter=U --name-only    # non-empty = unmerged index entries present
```

If that lists files and the State 1 marker check above is empty, you are in State 2.

An orphaned autostash may also be present. The pull that conflicted saved your working-tree
changes to the git stash before rebasing (via `--autostash`). When the rebase was interrupted
without completing, that stash entry was never automatically restored. Check:

```bash
$ git stash list   # look for a line containing "autostash"
```

**Automated recovery (recommended):** `nomad pull --force-remote` handles this state too. It
clears the stuck index via `git reset --mixed HEAD` (preserving your working-tree edits), reports
any orphaned autostash entry with a hint so you can decide what to do with it, then re-pulls.
Unlike State 1, there is nothing to abort and no stranded commits to park, so recovery is simpler.

**Manual runbook:**

```bash
$ cd ~/claude-nomad
$ git reset --mixed HEAD    # clear the stuck index; your working-tree edits are preserved

# Review working-tree files for leftover conflict markers (<<<<<<<, =======, >>>>>>>):
$ git diff --name-only      # files with unstaged changes likely still carry markers

# If git stash list shows an autostash entry, decide what to do with it:
$ git stash pop             # restore the autostashed changes (may re-conflict; review first)
$ git stash drop            # discard the autostash if you do not need those changes

$ nomad pull
```

Use `git reset --mixed HEAD` here, not `git reset --hard`. The `--mixed` form clears only the
index, leaving your working-tree files as-is, so any work in progress is not discarded. The
`--hard` form would throw away working-tree edits too.

## A hook that worked before nomad now fails with "Cannot find module"

```text
SessionStart:startup hook error
Error: Cannot find module '../some-tool/lib/helper.cjs'
Require stack:
- /home/you/claude-nomad/shared/my-tool/check-update.js
```

The giveaway is the require stack: the failing script shows up under your **sync repo**
(`~/claude-nomad/shared/...`) instead of `~/.claude/...`.

Here is what happens. On a synced host, a directory added via `sharedDirs` (see
[Shared support dirs](/claude-nomad/how-it-works/#shared-support-dirs-shareddirs)) is a symlink
into the sync repo. When Node runs a script from it, it resolves symlinks first, so the script
"believes" it lives in `~/claude-nomad/shared/my-tool/`. If the tool loads another file by a path
relative to its own location (say `require('../tool-runtime/helper.cjs')`, expecting to find
`~/.claude/tool-runtime/` next door), the lookup happens inside the sync repo, where that directory
does not exist. The hook crashes with `MODULE_NOT_FOUND`.

For Node hooks the fix is one flag, `--preserve-symlinks-main`, which tells Node to keep the
symlinked path so relative lookups resolve back under `~/.claude/`:

```json
"command": "node --preserve-symlinks-main \"$HOME/.claude/my-tool/check-update.js\""
```

Make that edit in `shared/settings.base.json` in your sync repo, not in `~/.claude/settings.json`
(see the first question for why), then push and pull as usual.

Any tool that stores hook scripts in a `sharedDirs`-symlinked directory and references other
`~/.claude/` paths relative to its own file location can hit this, often right after the tool
updates itself. You do not have to spot it yourself: `nomad doctor` warns about hook commands with
this shape and prints the same fix hint.

:::note
`hooks/` and `agents/` are **not** synced by nomad. They are installed per-host by
`@opengsd/gsd-core` via npm and are marked reserved so they cannot be re-added through `sharedDirs`.
See [gsd-owned directories: hooks/agents not synced](#gsd-owned-directories-hooksagents-not-synced).
:::

## Is nomad update different from npm update -g claude-nomad?

No. `nomad update` runs the npm self-update for you; it is a convenience wrapper, nothing more.
Use whichever you prefer.

## I have local changes to push and remote changes to pull. What order do I run them in?

**Push first, then pull.**

```bash
$ nomad diff   # optional: preview what a pull would apply, without locking anything
$ nomad push   # your local changes win and land in the sync repo
$ nomad pull   # apply the merged repo state back to ~/.claude/
```

Why this order works:

1. **`nomad push` already does the pull's git half for you.** Before touching anything, push
   rebases your sync repo on the remote, so commits from other hosts are integrated first. Then
   your local state (sessions, extras, hooks) is copied over the repo tree and pushed. When the
   same file changed on both sides, your local copy wins (last-write-wins is the designed model).
   Conflicts that git cannot rebase cleanly stop the push at the rebase step so you can resolve
   them by hand.

2. **`nomad pull` then applies the merged result locally**: it regenerates `settings.json` from
   the base and host files, refreshes the symlinks, and copies down anything other hosts pushed
   that you did not have yet.

The reverse order is the lossy one. Pulling first overwrites your diverging local files with the
repo versions; that is exactly what the warning below is telling you:

```text
⚠︎ local .planning for claude-nomad diverges from origin in 3 file(s); next remapExtrasPull will overwrite them
```

If you pull anyway, your overwritten files are recoverable from
`~/.cache/claude-nomad/backup/<timestamp>/`, but pushing first means you never need them. The
divergence warning prints the exact backup path it wrote; otherwise, find the newest backup and
copy the file back. Inside the backup, extras live under `extras/<encoded-project-path>/` (the
project's absolute path with slashes turned into dashes):

```bash
$ ls -t ~/.cache/claude-nomad/backup/ | head -1    # newest backup, named <timestamp>
$ cp ~/.cache/claude-nomad/backup/<timestamp>/extras/-home-you-code-myproject/.planning/ROADMAP.md \
     ~/code/myproject/.planning/ROADMAP.md
```

Then push so the repo gets your restored copy and the warning stops firing.

One nuance: because push is last-write-wins, if the *same file* genuinely changed on two hosts,
the host that pushes last clobbers the other's version in the sync repo (the older copy survives
only in git history). If you suspect a real both-sides edit on something you care about, run
`nomad diff` first and reconcile by hand before pushing.

## gsd-owned directories: hooks/agents not synced

`hooks/` and `agents/` under `~/.claude/` are owned and installed by `@opengsd/gsd-core` (the GSD
tool) per host via `npm i -g @opengsd/gsd-core`. Because every host runs `npm install`
independently, each host always gets a self-consistent set of hook scripts for its own gsd version.
Syncing these directories was pure churn: two hosts on different gsd versions would overwrite each
other's versioned scripts on every push/pull cycle.

As of this version, nomad drops `hooks/` and `agents/` from the sync set entirely. If you upgrade
from an older version that did sync them, the repo trees at `shared/hooks/` and `shared/agents/`
stay in place as inert history. You do not need to delete them from the repo. Nomad will not touch
them on push or pull.

**Skills** are handled differently: your own skills (any `~/.claude/skills/` entry that does not
start with `gsd-`) still sync, but as a filtered copy rather than a symlink. The `gsd-*` skills are
excluded from both push and pull; gsd reinstalls them per host via npm.

## I upgraded nomad and now nomad doctor shows a migration hint for hooks or agents

After upgrading to a version that drops `hooks` and `agents` from the sync set, any host that
previously synced them will still have a `~/.claude/hooks` symlink pointing at the old
`shared/hooks/` tree. That symlink is harmless: gsd's per-host install creates the real directory
it needs regardless of what is at that path.

`nomad doctor` detects the leftover symlink and emits a migration hint:

```text
⚠︎ ~/.claude/hooks is a symlink left over from the pre-upgrade sync era
   gsd (@opengsd/gsd-core) now owns this directory and installs it per host via npm.
   Remove the symlink and let gsd reinstall a real directory on its next run:
   rm ~/.claude/hooks
```

To resolve it, run the command shown in the hint:

```bash
$ rm ~/.claude/hooks
```

Gsd reinstalls a real `~/.claude/hooks/` directory the next time it runs (on session start, or
when you run any gsd command). The same applies to `~/.claude/agents`. After removing both, run
`nomad doctor` again to confirm the hints are gone.

The hint is informational only (a WARN, not a FAIL) and does not affect pull or push.

## Can I pin a gsd version to keep hook scripts byte-identical across hosts?

Yes, though it is optional and fragile as a primary strategy.

If all your hosts run the exact same `@opengsd/gsd-core` version, the `gsd-*` files gsd installs
are byte-identical on every machine. This means even if a sync path accidentally carried them, the
result would be a no-op. Pinning one version is useful as an extra layer of defense while you
transition, or in a team setting where you want to coordinate gsd upgrades.

To pin:

```bash
$ npm i -g @opengsd/gsd-core@<version>   # run on every host
```

**Why this is not the primary fix:** the moment you update gsd on one host, that host's `gsd-*`
files diverge from the others. The defense only holds for as long as every host stays on the same
version, which is hard to guarantee over time. The structural fix (dropping `hooks/` and `agents/`
from the sync set) is the reliable solution; version pinning is an optional complement, not a
replacement.
