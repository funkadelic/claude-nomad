---
title: Quickstart
description: Install and configure claude-nomad in four steps.
---

## Requirements

- Node.js 22.22.1 or newer (24 LTS recommended; the npm `engines` field declares the 22.22.1 floor
  and surfaces a warning on older runtimes -- npm only blocks the install when `engine-strict=true`
  is configured)
- Git
- [`gitleaks`](https://github.com/gitleaks/gitleaks) (required for `nomad push`, which exits with
  an error if it is not on PATH; `nomad doctor` also checks it against the pinned 8.30.x and warns
  when it is absent or mismatched)
- `gh` ([GitHub CLI](https://cli.github.com/)), required by `nomad init` to create and wire the
  private sync repo. When `gh` is missing or unauthenticated, `nomad init` exits with a FATAL and
  shows install / `gh auth login` guidance. On hosts where the private repo is already set up (all
  subsequent hosts), `gh` is only needed by `nomad doctor`'s Actions-drift check and auto-disable;
  pull and push work without it.

**Optional:**

- [curl](https://curl.se/) or [wget](https://www.gnu.org/software/wget/), the HTTP fetcher behind
  the version-staleness check (`nomad doctor` latest-release line) and
  `nomad doctor --check-schema`. curl is tried first and wget is the fallback, so either one works.
  The checks soft-skip (no error, no exit-code change) when neither is present, so the rest of the
  CLI works without it; `nomad doctor` shows a single "HTTP fetcher" row that names the binary in
  use (for example `HTTP fetcher: curl 8.5.0`) when either is installed, and warns only when both
  are absent.

## First host (once, ever)

```bash
# 1. Install the CLI.
$ npm i -g claude-nomad

# 2. Create your private sync repo and scaffold it. nomad init uses gh to
#    create the repo, wire origin, and disable Actions, then scaffolds locally.
$ nomad init                   # prompts for a repo name (default: claude-nomad-config)
$ nomad init --repo my-config  # non-interactive: use this name, no prompt

# 3. Add a stable host label to ~/.zshrc or ~/.bashrc, then reload.
export NOMAD_HOST=<your-host-label>

# 4. Publish the scaffold to your private repo.
$ nomad push
```

Then the everyday loop on any host:

```bash
$ nomad doctor   # confirm setup
$ nomad sync     # pull config, then publish local changes, in one step
```

`nomad sync` always pulls first and then pushes, so there is no ordering to remember. The
lower-level `nomad pull` and `nomad push` remain available when you need their extra flags; see
the [command reference](/claude-nomad/commands/#sync).

## Each additional host

```bash
$ npm i -g claude-nomad
$ gh repo clone <your-username>/<your-repo-name> ~/claude-nomad   # default: claude-nomad-config
export NOMAD_HOST=<your-host-label>   # add to ~/.zshrc or ~/.bashrc
$ nomad pull
```

## Windows

claude-nomad runs natively on Windows (PowerShell or cmd), and WSL2 works too. The everyday loop is
the same either way.

:::note[How native Windows differs under the hood]
On macOS, Linux, and WSL2, claude-nomad **symlinks** your shared config into `~/.claude/`, so there
is only ever one file: the one in your sync repo.

Native Windows cannot use symlinks, because creating one there needs Developer Mode or admin
rights. claude-nomad keeps a **real copy** in `~/.claude/` instead. That leaves two files to keep in
step, and claude-nomad does it for you: `nomad pull` and `nomad sync` both copy your edits into the
repo before they fetch, so an unpublished edit is never overwritten. A file you delete from a shared
directory is handled the same way: it is removed from the repo by the next pull too, exactly as
deleting inside a symlinked directory already removes it on macOS or Linux. The first pull after you
upgrade to this version is the one exception, because this machine has no record to compare against
yet: a deletion made before that pull comes back once, and deleting it again sticks. Enabling
Developer Mode does not change this; copies are used on every native Windows host either way.
:::

Two things come from native Windows specifically, both in the list below: a `.gitleaksignore` allow
entry may not travel to a macOS, Linux, or WSL2 host, and deep session paths can hit the native
Windows 260-character path limit.

The native Windows steps are the same as [First host](#first-host-once-ever) and
[Each additional host](#each-additional-host) above, with a couple of PowerShell-specific swaps:

```powershell
# 1. Install the CLI.
> npm i -g claude-nomad

# 2. Create your private sync repo and scaffold it.
> nomad init

# 3. Add a stable host label. PowerShell has no ~/.bashrc equivalent, so set it
#    as a persistent user environment variable instead, then restart your
#    terminal so the new value is picked up.
> [System.Environment]::SetEnvironmentVariable('NOMAD_HOST', '<your-host-label>', 'User')
#    Using cmd instead of PowerShell? The equivalent one-liner is:
#    setx NOMAD_HOST <your-host-label>

# 4. Publish the scaffold to your private repo.
> nomad push
```

A few native Windows specifics worth knowing. WSL2 behaves like Linux, so the copy-sync and
path-length items below do not apply to it; the `.gitleaksignore` one can still reach it, from the
other side:

- **Installing gh:** `winget install GitHub.cli` (or `scoop install gh`), then `gh auth login`.
  Needed before `nomad init` on the first host; later hosts only clone with it.
- **Installing gitleaks:** `winget install gitleaks.gitleaks` (or `scoop install gitleaks` if you
  use Scoop). `nomad doctor` prints the same hint whenever gitleaks is missing from PATH.
- **Shared config is copied, not symlinked.** On macOS and Linux, files like `CLAUDE.md` and your
  skills live in the sync repo and are symlinked into `~/.claude/`, so there is one source of truth
  on disk. Creating a symlink on native Windows needs Developer Mode or admin rights, so there these
  are real copies instead, whether or not you have Developer Mode enabled. WSL2 is unaffected and
  behaves like Linux. What this means for you: nothing extra. On native Windows both `nomad pull`
  and `nomad sync` mirror your local copies into the repo before they fetch, so an unpublished edit
  is captured rather than reverted, and a real `nomad pull` now prints a `Symlinks` line for each
  name it captured, so the copy is visible instead of silent. A file you delete from a shared
  directory is handled the same
  way: it is removed from the sync repo by the next pull, exactly as deleting inside a symlinked
  directory already removes it on macOS or Linux. The removal is left uncommitted, so it publishes
  on your next push and passes the same secret scan as everything else, and the file is snapshotted
  to the backup dir first. The safety rule behind this: nomad only removes a file it has a record of
  having given this machine, so a repo file this machine has never synced is never touched. That
  record is also why the first pull after you upgrade to this version is an exception: there is
  nothing to compare against yet, so a deletion made before that pull comes back once, and deleting
  it again sticks. `nomad pull --force-remote` recovers a wedged sync repo. When the repo is stuck
  mid-rebase or mid-merge, recovery resets it to match the shared repo, and on native Windows that
  reset also replaces your shared config with the repo's copy; the pull now warns naming what was
  reverted, with the copy it replaces snapshotted to the backup dir first. A different stuck state,
  an unfinished index with nothing to abort, recovers by clearing the index without touching your
  working files, so on native Windows your shared config is left exactly as it was. This is the
  same behavior claude-nomad's `skills/` sync already has on every platform.
- **The copy-in never carries your Claude secrets or session history.** The same mirror that
  captures your Windows edits into the sync repo refuses to copy any path with a part on
  claude-nomad's never-sync list, whether that part is a directory along the way or the file name
  itself (session transcripts, credentials, caches, and other ephemeral `~/.claude/` state; see
  `NEVER_SYNC` in `src/config.never-sync.ts` for the exact set). If something on that list somehow
  lands in the sync repo working tree anyway, such as a file edited directly in the repo rather
  than through `~/.claude/`, what happens next depends on whether Git already tracks it. If it does
  not, the next `nomad pull` deletes it, snapshotting it to the backup dir first, and prints a
  warning naming the file. If it does, pull leaves the file untouched and prints a warning naming
  the file and the exact command to run to finish clearing it yourself. One thing worth knowing:
  that list is not only secrets, it also uses a few ordinary-sounding names (`sessions`, `tasks`,
  `plans`, `cache`, and others) that Claude Code itself uses under `~/.claude/`. A path inside one
  of your shared names stops mirroring as soon as any part of it is spelled exactly like one of
  those; the spelling has to match in full, so a file named `tasks.md` is unaffected.
- **A `.gitleaksignore` allow entry may not travel across hosts.** gitleaks fingerprints each
  finding using the file path exactly as it saw it: backslashes on native Windows, forward slashes
  on macOS/Linux/WSL2. If you allow a finding with `nomad push --allow` (or `nomad allow`) on native
  Windows, the identical finding can reappear as "new" the first time it is scanned from a macOS,
  Linux, or WSL2 host, and the same happens in reverse. This is a known gitleaks limitation, not a
  claude-nomad bug; just allow it again from the other host.
- **Deep session paths and the native Windows path-length limit.** `nomad doctor` checks `git config
  core.longpaths` and the Windows `LongPathsEnabled` registry value, and warns if either is off.
  Turning both on avoids problems with the classic 260-character path limit, which a deeply nested
  project's encoded session path can otherwise exceed.
- **Line endings stay put.** A fresh `nomad init` writes a `.gitattributes` with `* -text`, so Git
  never converts line endings between hosts. If you are joining a sync repo created before this file
  existed, add that one line from any host (or watch for the `nomad doctor` warning that nudges
  you), otherwise a native Windows checkout with the common `core.autocrlf=true` Git default would
  rewrite every text file's line endings, and every host would then see the whole tree as
  permanently changed.

## Privacy by default

Your private sync repo must stay private. Session transcripts contain the full text of your
conversations. `nomad init` disables Actions on the new repo as soon as it is created, via the
GitHub API call `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false`. What
this means for you: the repo `nomad init` creates ships no workflows of its own, so this is a
precaution, not a fix for a known problem. It guarantees that no CI (which could echo transcript
content into build logs) can ever run against your private data repo, even if a workflow file is
added later; you do not need to remember to do it.

Pass `--keep-actions` to skip the disable step (for example, when your org already enforces an
Actions policy).

:::caution
If you ever make the repo public, your session transcripts (which include conversation content)
become world-readable. **Keep it private.**
:::

## Per-project Claude config: in-repo vs sidecar

Some projects keep their Claude config (a `.claude/` directory with `hooks/`, `agents/`,
`commands/`, a project `settings.json`) **committed to the project's own git repo**. Others keep it
as a **local sidecar**, listed in `.gitignore` so it is never committed. nomad's per-project extras
are for the sidecar case only.

- **Committed to the project repo:** do nothing in nomad. Cloning the repo on another machine
  already brings `.claude/`, and the repo is the source of truth. Adding it to nomad's `extras`
  would create a second, competing copy, and because a pull mirrors the synced copy over your
  working tree (last write wins) it can overwrite or revert the committed version.
- **Git-ignored sidecar:** add `.claude` to that project's entry in the `extras` field of
  `path-map.json` so nomad carries it across your machines. On push nomad strips host-local and
  ephemeral state (session transcripts, `settings.local.json`, caches), syncing only config.

The same rule applies to `.planning/` and a project-level `CLAUDE.md`: sync them through extras only
when the project git-ignores them. See [How it works](/claude-nomad/how-it-works/) for the exact
fields and the filtering boundary.

## Setup: first host in detail

`nomad init` creates the private repo via `gh`, wires it as `origin`, disables Actions, scaffolds
the directory layout. You then run `nomad push` to publish. The `gh` CLI must be installed and
authenticated before you run it.

```bash
# Install the CLI.
$ npm i -g claude-nomad

# Create the private sync repo and scaffold it. You will be prompted for a
# repo name (default: claude-nomad-config). Pass --repo to skip the prompt.
$ nomad init
# or non-interactively:
$ nomad init --repo my-config

# If ~/.claude/ is already populated on this host, capture it as the starting
# point instead of an empty scaffold. Stages shared/ and writes
# hosts/<NOMAD_HOST>.json from your current ~/.claude/settings.json.
# Does NOT touch the originals.
$ nomad init --snapshot
```

`nomad init` refuses to clobber existing scaffold artifacts, so re-running on a populated repo is
a safe no-op (it errors out naming the offender). `nomad pull` against an unscaffolded repo fails
fast with `FATAL: repo not initialized; run 'nomad init' to scaffold` instead of silently leaving
a half-state.

Add a stable host label to your shell rc, then reload it:

```bash
export NOMAD_HOST=<your-host-label>   # add to ~/.zshrc or ~/.bashrc
```

`NOMAD_HOST` overrides `os.hostname()`, which returns noisy values like `WINDOWS-I5NT6OH` on WSL
or `<name>.local` on macOS. Pick a clean label per machine (e.g., `wsl-laptop`, `macbook`,
`homelab-nuc`). `nomad doctor` reports the resolved host so you can confirm.

Edit `path-map.json` to add your logical projects (see [How it works](/claude-nomad/how-it-works/)), then:

```bash
$ nomad doctor                # read-only state check; reports host, repo state, and any check
                              # needing action (compact by default; -v shows all passing checks),
                              # each marked checkmark (pass) / cross (fail) / warning (warn)
$ nomad doctor --check-shared # read-only gitleaks preflight over the session transcripts a push
                              # would stage
$ nomad diff                  # preview what nomad pull would change on this host; no lock,
                              # no network, no mutation
$ nomad push                  # send current state to the private remote
$ nomad pull                  # apply on another host (or this one after a remote update)
```

`nomad pull --dry-run` is the network-aware twin of `nomad diff`: it acquires the lock and runs
`git pull` so you see what the next real pull would do given the latest remote, then exits without
mutating.

If the destination host already has populated `~/.claude/{CLAUDE.md, agents/, ...}`, the first
`nomad pull` will refuse to overwrite real files. See [Usage](/claude-nomad/usage/) for the safe migration
flow.

## Setup: each additional host in detail

```bash
# Install the CLI.
$ npm i -g claude-nomad

# Clone your private data repo (<your-repo-name> defaults to claude-nomad-config).
$ gh repo clone <your-username>/<your-repo-name> ~/claude-nomad
# or with plain git:
$ git clone git@github.com:<your-username>/<your-repo-name>.git ~/claude-nomad

# Add to ~/.zshrc or ~/.bashrc, then reload.
export NOMAD_HOST=<your-host-label>

$ nomad pull   # apply config to ~/.claude/
```

`npm i -g claude-nomad` puts a `nomad` binary on your PATH. What this means for you: there is no
compile step, no extra transpiler to install, and nothing is fetched from the network the first
time you run `nomad`, so the first run works offline. (The Node version floor and the
`engine-strict` caveat are in the Requirements section above.)
