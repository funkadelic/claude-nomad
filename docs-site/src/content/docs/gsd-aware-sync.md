---
title: GSD-aware sync
description: What nomad does for GSD users out of the box, from .planning overlay sync to gsd-owned hook exclusion.
---

If you use [gsd-core (`@opengsd/gsd-core`)](https://opengsd.net/products/gsd-core) alongside
claude-nomad, several sync behaviors are wired specifically for you, and they are active without
any extra configuration.

This page collects those behaviors in one place so you know exactly what nomad does for a GSD
machine out of the box and what you still need to handle yourself. For the underlying sync
mechanics (path remapping, the settings deep-merge, and the full synced-vs-not-synced breakdown),
see [How it works](/claude-nomad/how-it-works/).

## Table of contents

- [.planning overlay sync](#planning-overlay-sync)
- [gsd-owned hooks and agents are not synced](#gsd-owned-hooks-and-agents-are-not-synced)
- [gsd-owned hook entries in settings are not synced](#gsd-owned-hook-entries-in-settings-are-not-synced)
- [gsd-prefixed skills are excluded](#gsd-prefixed-skills-are-excluded)
- [Version-pin stopgap](#version-pin-stopgap)
- [.claude extras filtering](#claude-extras-filtering)
- [The one manual step](#the-one-manual-step)

## .planning overlay sync

When a project opts its `.planning/` directory into extras sync (via the `extras` field in
`path-map.json`), nomad syncs it as an **additive overlay**, not a mirror.

On push, nomad copies your local `.planning/` to `shared/extras/<logical>/.planning/` in the
sync repo (filtered by `ALWAYS_NEVER_SYNC` so credentials never ride through, but `todos/` and
`plans/` content passes). On pull, nomad overlays the repo copy onto your local tree: files are
added and updated, but nothing is blindly deleted. Genuine upstream deletions still propagate:
nomad diffs the repo's pre- and post-rebase HEADs and removes locally only the files the rebase
actually deleted. That delete pass is skipped on `--dry-run` and on a fresh clone where there is
no pre-rebase HEAD to diff against.

The practical effect: a live working tree of unpushed plans survives a pull from another host. A
`.planning/` file that only the other host has pushed is added to your tree. Files you have locally
but have not yet pushed stay untouched.

This behavior is implemented in `src/extras-sync.ts`. It applies to any project that lists
`.planning` in its `extras` array; it is not conditional on GSD being installed.

## gsd-owned hooks and agents are not synced

`hooks/` and `agents/` are not part of `SHARED_LINKS`. They are installed per-host by
`@opengsd/gsd-core` via its own npm install, which means:

- Nomad no longer copies hooks or agents between machines.
- You get no cross-host version skew: each host runs the hooks and agents from its own
  `@opengsd/gsd-core` install.
- The sync repo does not accumulate gsd-generated hook and agent churn.

This is implemented in `src/links.ts` (the `SHARED_LINKS` constant). The names `hooks` and
`agents` are also reserved in the `sharedDirs` validation logic, so you cannot accidentally
re-add them through the opt-in path.

## gsd-owned hook entries in settings are not synced

Separate from the `hooks/` directory above, GSD also registers its hook commands as entries inside
`~/.claude/settings.json` (under the `hooks` key), and it re-applies them on every session start
with host-correct launcher paths and whatever hook set the installed gsd version ships. Because
those entries are managed per host by GSD, syncing them is the same churn as syncing the script
files: the generated merge would always lag the live file, and `nomad doctor` would report a
permanent "hooks diverged" drift that no pull could resolve.

Nomad treats a hook entry as gsd-owned when its command runs a script whose basename starts with
`gsd-`. What that means for you:

- **On pull:** gsd-owned hook entries are filtered out of the generated `~/.claude/settings.json`,
  so the `hooks` block GSD manages is left for GSD to own. The spurious "hooks diverged" warning is
  gone because nomad no longer writes a stale set to compare against.
- **On push:** if your committed `shared/settings.base.json` still holds leftover gsd hook entries
  from an earlier version of nomad, the next `nomad push` rewrites the base to drop them before
  staging. It is a one-time self-clean, backed up first and idempotent once the base is clean, and
  it never runs on pull or `--dry-run`. While the committed base still has them, `nomad doctor`
  shows a one-time info line (not a warning) telling you the base self-cleans on your next push.
- **Your own hooks still sync.** A hook entry you write yourself (whose script basename does not
  start with `gsd-`) is ordinary ahead-only state: run `nomad capture-settings` to promote it into
  `shared/settings.base.json`, and it then travels on every subsequent pull like any other setting.
- **In `nomad diff` and `--dry-run`:** the preview applies the same filter to both sides before
  comparing, so GSD's per-session hook self-heal never shows up as a phantom `hooks` removal. What
  the preview shows is what a real pull would actually write.

This is implemented in `src/hooks-filter.ts` (the `isGsdHookEntry` detector and the
`stripGsdHookEntries` walker), wired into the pull-side settings write, the diff and dry-run
preview, the drift comparison, and the push-time base self-clean.

## gsd-prefixed skills are excluded

`skills/` is copy-synced (not symlinked) via `src/skills-sync.ts`. The ownership predicate is the
`gsd-` name prefix: any skill whose directory name starts with `gsd-` is treated as gsd-owned and
excluded from both push and pull.

On push: only non-`gsd-` skills are copied from `~/.claude/skills/` to `shared/skills/`. On pull:
only non-`gsd-` skills are overlaid from `shared/skills/` into `~/.claude/skills/`; `gsd-*` names
are never touched.

This means your own skills (any name that does not start with `gsd-`) travel across machines
normally, while gsd's own skills stay out of the sync repo and are reinstalled per-host by
`@opengsd/gsd-core` via npm.

A leftover `~/.claude/skills` symlink (from before the copy-sync switch) is migrated to a real
directory on the first pull.

## Version-pin stopgap

Because `@opengsd/gsd-core` installs hooks and agents per host via npm, two machines running
different gsd versions will have different hook and agent files. If those files were synced, every
push from a host with a newer gsd version would overwrite them on hosts running an older version.

The practical stopgap is to pin `@opengsd/gsd-core` to the same version
across all your hosts. With a single version active everywhere, the gsd-owned files are
byte-identical across hosts, and the combination of the exclusions above (no hook/agent sync,
no gsd-skill sync) means nothing conflicts.

Pinning is a defense-in-depth measure. The exclusions are primary; the pin prevents latent
conflicts from a future session where two hosts drift apart.

## .claude extras filtering

When a project opts its `<repo>/.claude/` directory into extras sync, nomad applies a per-name
denylist on both push and pull. The denylist (`CLAUDE_EXTRA_NEVER_SYNC` in `src/config.ts`) is
the full `NEVER_SYNC` set plus `projects/`, which strips session transcripts, `settings.local.json`,
`shell-snapshots/`, `sessions/`, and other host-local or ephemeral names, leaving only portable
config (skills, commands, rules, `settings.json`).

The same boundary is enforced a second time at the push gate in `commands.push.allowlist.ts` as
a backstop. On pull, the filter prevents a poisoned repo entry from restoring a host-local file
onto the host.

GSD users who opt `.claude` into extras get their project-scoped Claude config synced without
leaking per-host files or session state.

## The one manual step

Nomad does not carry `hooks/` or `agents/` between machines. On a new host, you get those from
gsd's own install:

```bash
npm i -g @opengsd/gsd-core
```

That single install step is what gives the new host its gsd hooks and agents. A `nomad pull` will
not do it for you.

Everything else (your skills, settings, session transcripts, project extras) arrives via the normal
`nomad pull` flow.
