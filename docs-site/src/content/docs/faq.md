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

This means a **previous** pull's rebase hit a conflict and was never resolved, leaving your sync
repo (`~/claude-nomad/`) stuck mid-rebase. Every pull since then has died on the same wall.
Recovery is manual but quick:

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
`~/.cache/claude-nomad/backup/<timestamp>/`, but pushing first means you never need them.

One nuance: because push is last-write-wins, if the *same file* genuinely changed on two hosts,
the host that pushes last clobbers the other's version in the sync repo (the older copy survives
only in git history). If you suspect a real both-sides edit on something you care about, run
`nomad diff` first and reconcile by hand before pushing.
