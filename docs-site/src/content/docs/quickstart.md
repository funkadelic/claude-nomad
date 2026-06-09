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
$ nomad pull     # apply config to ~/.claude/
$ nomad push     # publish local changes (sessions, settings)
```

## Each additional host

```bash
$ npm i -g claude-nomad
$ gh repo clone <your-username>/claude-nomad-config ~/claude-nomad
export NOMAD_HOST=<your-host-label>   # add to ~/.zshrc or ~/.bashrc
$ nomad pull
```

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
$ nomad doctor                # read-only state check; reports host, repo state, every check as
                              # checkmark (pass) / cross (fail) / warning (warn)
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

# Clone your private data repo.
$ gh repo clone <your-username>/claude-nomad-config ~/claude-nomad
# or with plain git:
$ git clone git@github.com:<your-username>/claude-nomad-config.git ~/claude-nomad

# Add to ~/.zshrc or ~/.bashrc, then reload.
export NOMAD_HOST=<your-host-label>

$ nomad pull   # apply config to ~/.claude/
```

`npm i -g claude-nomad` puts a `nomad` binary on your PATH. What this means for you: there is no
compile step, no extra transpiler to install, and nothing is fetched from the network the first
time you run `nomad`, so the first run works offline. (The Node version floor and the
`engine-strict` caveat are in the Requirements section above.)
