---
title: Recipes
description: Copy-pasteable example configs for common claude-nomad setups, from a fresh host to cross-OS remapping and GSD integration.
---

These are complete, copy-pasteable configs for common setups. Every `path-map.json` shown lives at
the root of your private sync repo (alongside `shared/` and `hosts/`), and every `nomad` command is
run from any host that has that repo checked out. Pick the recipe closest to what you want and adapt
the names.

The repo layout these recipes assume:

```text
<your-sync-repo>/
  path-map.json            # the config you edit in these recipes
  shared/
    settings.base.json     # settings common to every host
    CLAUDE.md              # your global instructions (symlinked into ~/.claude/)
  hosts/
    <host>.json            # per-host settings overrides
```

Your host label comes from the `NOMAD_HOST` environment variable (it falls back to the machine
hostname, lowercased). Set it once per machine in your shell rc:

```bash
export NOMAD_HOST=macbook
```

## Table of contents

- [From scratch (single host)](#from-scratch-single-host)
- [Cross-OS project remapping](#cross-os-project-remapping)
- [Per-host settings overrides](#per-host-settings-overrides)
- [Seed the repo from an existing ~/.claude/](#seed-the-repo-from-an-existing-claude)
- [GSD integration](#gsd-integration)
- [Per-project extras (.claude sidecar)](#per-project-extras-claude-sidecar)
- [Third-party tool directory](#third-party-tool-directory)
- [Stop using nomad (offboard a machine)](#stop-using-nomad-offboard-a-machine)

## From scratch (single host)

Start here on the first machine, with nothing synced yet.

```bash
# 1. Install the CLI.
npm i -g claude-nomad

# 2. Create your private sync repo and scaffold it.
nomad init --repo my-config   # or bare `nomad init` to be prompted (default: claude-nomad-config)

# 3. Give this machine a stable label, then reload your shell.
echo 'export NOMAD_HOST=macbook' >> ~/.zshrc && source ~/.zshrc

# 4. Publish the scaffold.
nomad push
```

The scaffold writes a minimal `path-map.json`:

```json
{
  "projects": {}
}
```

An empty `projects` map is fine. Your global config (`shared/CLAUDE.md`, `commands/`, `rules/`,
`skills/`, and the generated `settings.json`) syncs without any project entries. You only add
entries to `projects` when you want session transcripts to follow you across machines, which is the
next recipe. The everyday loop on any host is `nomad doctor` to check state, `nomad pull` to apply
the repo to `~/.claude/`, and `nomad push` to publish local changes.

## Cross-OS project remapping

This is the feature most config-sync tools lack. The same project lives at a different absolute path
on each machine (`/Users/you/app` on a Mac, `/home/you/app` on Linux), so Claude Code stores its
session transcripts under a different directory key on each host. Mapping one logical name to both
paths lets your session history follow you.

```json
{
  "projects": {
    "app": {
      "macbook": "/Users/you/app",
      "linux-box": "/home/you/app"
    }
  }
}
```

The keys under `"app"` are host labels (the `NOMAD_HOST` value on each machine); the values are that
project's absolute path on that host. On push, nomad copies this host's transcripts into the repo
under the logical name `app`; on pull, it copies them back into the right per-host directory. Add one
block per project you want remapped. Projects that are not listed here are left alone in both
directions, so you can map only the repos you actually move between machines.

## Per-host settings overrides

`~/.claude/settings.json` is regenerated on every pull as a deep merge of
`shared/settings.base.json` (common to all hosts) with `hosts/<host>.json` (this machine only). Put
shared settings in the base and per-machine differences in the host file.

`shared/settings.base.json`:

```json
{
  "env": {
    "EDITOR": "nvim"
  },
  "permissions": {
    "allow": ["Bash(git status)", "Bash(git diff)"]
  }
}
```

`hosts/macbook.json`:

```json
{
  "env": {
    "EDITOR": "code --wait"
  }
}
```

The merged `settings.json` on `macbook` has `EDITOR` set to `code --wait` (the host value overrides
the base scalar) and keeps the `permissions.allow` list from the base (objects merge recursively).
One caveat: arrays replace, they do not concatenate. If `hosts/macbook.json` set its own
`permissions.allow`, that array would replace the base list entirely rather than extend it. A `null`
in a host file is a valid override that unsets the base value. Never hand-edit
`~/.claude/settings.json` on a synced host: it is overwritten on the next pull. Edit the base or the
host file in the repo instead. If you have already made local edits you want to keep, run
`nomad capture-settings` to promote those keys into the shared base (or `--host` to write them to
this machine's host file) before your next pull clobbers them.

## Seed the repo from an existing ~/.claude/

If this machine already has a populated `~/.claude/` you want to use as the starting point, seed the
repo from it instead of pushing an empty scaffold:

```bash
nomad init --repo my-config --snapshot
```

`--snapshot` stages your current global config into `shared/` and writes `hosts/<host>.json` from
your existing `~/.claude/settings.json`. It does not modify the originals. Review what landed under
`shared/`, then publish:

```bash
nomad push
```

Other hosts then `nomad pull` to adopt the same config.

## GSD integration

If you use GSD (`@opengsd/gsd-core`), most of the integration is automatic: `gsd-*` skills are
excluded from sync (the tool installs them per-host), and `hooks/` and `agents/` are gsd-owned per
host and are not synced at all, which avoids cross-host churn when two machines run different gsd
versions. GSD's hook entries inside `settings.json` are likewise filtered out of the generated file
on pull and self-cleaned from `shared/settings.base.json` on push, so they no longer surface as a
recurring drift warning. The one manual step is installing gsd on each machine:

```bash
npm i -g @opengsd/gsd-core
```

What you can opt into is a project's `.planning/` directory, so your roadmap and phase artifacts
travel with the project. Add it under the `extras` field, keyed by the same logical project name you
use in `projects`:

```json
{
  "projects": {
    "app": {
      "macbook": "/Users/you/app",
      "linux-box": "/home/you/app"
    }
  },
  "extras": {
    "app": [".planning"]
  }
}
```

For the full picture of what nomad does for a GSD machine out of the box, see
[GSD-aware sync](/claude-nomad/gsd-aware-sync/).

## Per-project extras (.claude sidecar)

A project can also sync its own `<repo>/.claude/` config directory (distinct from the global
`~/.claude/`) so a project-local Claude setup travels with it. The eligible extra names are
`.planning`, `CLAUDE.md`, and `.claude`. List the ones you want per project:

```json
{
  "extras": {
    "app": [".planning", ".claude"]
  }
}
```

The `.claude` extra is filtered so only config travels and host-local or ephemeral state is stripped
on push. See [How it works](/claude-nomad/how-it-works/) for the filtering detail. Opt a name in
only when the project git-ignores it, otherwise the project repo already syncs it.

## Third-party tool directory

If a tool other than GSD installs a support directory under the global `~/.claude/`, opt that
directory into symlink sync with the top-level `sharedDirs` field:

```json
{
  "projects": {},
  "sharedDirs": ["my-tool"]
}
```

Each listed name is symlinked from `shared/<name>` into `~/.claude/<name>`. Entries are validated
before linking: a name must be a single path segment (no `/` or `..`), must not be one of the
never-synced names, and must not collide with a reserved name. In particular `hooks`, `agents`, and
`skills` are reserved and cannot be re-added this way: `hooks` and `agents` are gsd-owned per host,
and `skills` is handled by the filtered copy-sync. Invalid entries are dropped with a warning rather
than aborting the run.

## Stop using nomad (offboard a machine)

When you are decommissioning a machine, or just want to stop syncing it, `nomad eject` leaves your
`~/.claude/` fully working on its own. It walks every nomad-managed symlink and replaces it with a
real copy of its target, so nothing breaks once the sync repo is deleted:

```bash
# Preview what would be materialized, without writing anything.
nomad eject --dry-run

# Replace every managed symlink with a real copy.
nomad eject
```

Eject only touches symlinks nomad created: real files and directories are left untouched, and it
aborts (pointing you at `nomad pull`) if it finds a dangling symlink rather than copying from an
unknown target. When it finishes it prints a manual-remainder checklist for the steps it cannot do
for you:

```bash
# 1. Remove the CLI.
npm rm -g claude-nomad

# 2. Drop the env vars and alias from your shell profile.
#    (NOMAD_HOST, NOMAD_REPO, and the `nomad` alias.)

# 3. Optional: delete the local clone of the sync repo once you no longer need it.
rm -rf ~/claude-nomad
```

Your config, sessions, and settings stay exactly where they are; they are just plain files again
instead of symlinks into the repo.
