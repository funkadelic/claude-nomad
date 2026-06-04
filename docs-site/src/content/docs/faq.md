---
title: FAQ
description: Common questions about day-to-day claude-nomad workflows.
---

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
