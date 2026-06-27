---
title: Usage
description: Migrating an existing setup, upgrading the CLI, cross-OS resume, and reading push/pull output.
---

## Migrating an existing ~/.claude/

If a host already has real files at `~/.claude/{CLAUDE.md, agents/, skills/, ...}` and you want to
bring them into the sync, the required sequence is `nomad init --snapshot` -> `nomad push` ->
`nomad pull`:

```bash
# From the host that has the canonical config (the originals are not modified):
$ nomad init --snapshot   # stages shared/ and writes hosts/<NOMAD_HOST>.json from ~/.claude/
$ nomad push              # publish the captured state to the private remote

# Then, on this host or any other host that has the private remote checked out:
$ nomad pull              # materializes the symlinks
```

`nomad pull` is what actually migrates the host. `applySharedLinks` runs a two-pass scan: any
pre-existing non-symlink at a `SHARED_LINKS` path whose counterpart exists under `shared/` is
renamed into `~/.cache/claude-nomad/backup/<ts>/` first, then the symlink is created. Your
originals are preserved under that timestamped backup directory, not deleted. Paths whose
`shared/<name>` is absent from the remote are left untouched, so a partial publish does not delete
data on the destination host.

If the remote has not been populated yet (you skipped `nomad init --snapshot` and `nomad push`),
`nomad pull` is a no-op for SHARED_LINKS: there is nothing on the remote to symlink against, so
your local `~/.claude/` files stay in place. The auto-move only triggers once the canonical state
is published.

Prefer an explicit tarball rollback and a confirmation prompt before any deletion? Write the
equivalent under `scripts/`: tar the `SHARED_LINKS` entries under `~/.claude/` first, copy into
`shared/`, prompt, then `nomad pull`. The auto-move path above is the recommended default.

## Upgrading the CLI

`nomad update` updates the `nomad` binary from npm:

```bash
$ nomad update
```

What this means for you: it runs `npm update -g claude-nomad` and refreshes the binary on your
PATH. It does NOT pull your sync data; run `nomad pull` separately when you want to apply remote
changes to this host.

`nomad doctor` reports when your local install is behind the latest npm release:
`warning claude-nomad: <local> -> <latest> (run nomad update)`. When the latest version cannot
be determined (offline, or an unexpected registry response), the line says
`version check skipped: could not determine latest version` instead of disappearing, so a
skipped check is never mistaken for "current".

## Cross-OS resume

Claude Code embeds the original `cwd` in each session transcript. When you resume on a different
host where that path doesn't exist, the picker prints a `cd <orig-cwd> && claude --resume <id>`
line that fails (the source-host path isn't there).

Run this instead:

```bash
$ eval "$(nomad doctor --resume-cmd <session-id>)"
```

Or pipe through bash:

```bash
$ nomad doctor --resume-cmd <session-id> | bash
```

`nomad doctor --resume-cmd <id>` reads the `.jsonl`'s recorded `cwd`, reverse-looks up the
logical project in `path-map.json`, finds your current host's abspath for that logical, and prints
`cd <local-abspath> && claude --resume <id>` to stdout. The command is read-only: it never
modifies any transcript byte.

If the session isn't mapped on this host, you'll see:

```text
cross session <id> not mapped on this host; add the logical to path-map.json
```

Other fatal surfaces: missing `~/.claude/projects/`, session id absent from every encoded dir, no
`cwd` field anywhere in the transcript, missing `path-map.json`, recorded cwd not present in any
logical's host map. All errors go to stderr prefixed with the fail glyph; the success line goes to
stdout as a bare shell command (no glyph) so `eval` works.

## Reading push and pull output

`nomad push` and `nomad pull` print a grouped tree, the same left-gutter layout you already see
from `nomad doctor`. There is a header line naming the command and host, then a few named sections
(`Sessions`, `Extras`, and so on), each with its items hanging off connectors. A status glyph
leads every line: pass-glyph green for something that synced, info-glyph dim for an informational
count, warning-glyph yellow for a warning, and fail-glyph red for a failure. What this means for
you: instead of one long flat list with a line per project, related work is grouped and the noise
is collapsed.

A clean `nomad push` looks like this (one pass row per project whose sessions were copied up, the
projects this host does not track folded into a single count, then the secret-scan result and a
one-line summary):

```text
push on host=workstation
Sessions
  ├ ✓ claude-nomad
  ├ ✓ my-side-project
  └ ℹ︎ 4 not in path-map (run nomad doctor to list)
Extras
  └ ✓ claude-nomad/.planning
Leak scan
  └ ✓ no leaks
Summary
  └ ✓ summary: clean
```

The `ℹ︎ 4 not in path-map` row is the collapse: rather than printing one line per project that this
host does not sync, push and pull now show a single count and point you at `nomad doctor`, which
lists those projects by name if you want the detail. The `Leak scan` section is the secret check
that runs before anything is published: `✓ no leaks` when the staged transcripts are clean. If a
secret IS found, that row turns into `✗ gitleaks detected secrets in N session transcript(s)` and
the full recovery block (which sessions, how to scrub them) still prints below the tree, exactly
as before. The same `Leak scan` row shows up under `nomad push --dry-run`, which runs that secret
scan as a read-only preview (nothing is written to the sync repo) and exits non-zero if the
preview finds anything.

A `nomad pull` is the mirror image, leading with the settings file it regenerated and then the
sessions and extras it copied down for this host:

```text
pull on host=workstation (backup=2026-05-27T14-02-09Z)
Settings
  └ ✓ settings.json (base + workstation.json)
Sessions
  ├ ✓ claude-nomad
  └ ℹ︎ 2 not in path-map (run nomad doctor to list)
Extras
  └ ✓ claude-nomad/.planning
Summary
  └ ✓ summary: clean
```

The `Summary` row is the final verdict for the run. It reads `✓ summary: clean` when everything
synced, or a warning naming the counts when something was skipped:

```text
⚠︎ summary: 3 unmapped on pull (run nomad doctor to list)
⚠︎ summary: 2 unmapped on push, 1 collisions (run nomad doctor to list)
```

Pass-glyph lines go to stdout; warning and fail-glyph lines go to stderr. An early, pre-tree
fatal abort (for example gitleaks missing when push checks for it, or a rebase conflict before
anything is staged) suppresses the tree entirely, so you do not see "summary: clean" stacked under
an error. A later leak-scan finding is different: by then the tree has already been built, so it
still renders in full with a fail-glyph `Leak scan` row and the recovery block below it. Projects
with no entry in `path-map.json` for this host count as unmapped and fold into the collapsed
info-count row; the hint points at `nomad doctor`, which lists them by logical name.

Settings drift comes in two directions. When your live `~/.claude/settings.json` is missing keys
that the repo merge would write, you are behind: `nomad pull` will restore them. When your live
file has keys not yet in the repo (an external tool such as Claude Code or GSD added them), you are
ahead: run `nomad capture-settings` to promote those keys into `shared/settings.base.json` (or
`hosts/<NOMAD_HOST>.json` with `--host`) before the next pull overwrites them. Both `nomad doctor`
and `nomad pull` warn on each direction with the matching fix command. `nomad push` also warns on
ahead-drift so you have a prompt to act before the commit completes.

A third case is when a key exists on both sides but its value diverged. This one is genuinely
ambiguous (either the repo or your local file could be the newer copy), so `nomad doctor` does not
blindly tell you to pull: it points at `nomad diff` to inspect, and notes that `nomad pull` would
overwrite local with the repo while editing the base or host file keeps the local value. The
comparison normalizes node launcher paths first, so a hook that differs only by a bare `node`
versus an absolute `/.../bin/node` path (the host-specific churn an external installer writes) is
not reported as drift.

`nomad doctor` also surfaces three conditions that are easy to miss on a fresh clone or after a
project moves. When the sync repo has no git committer identity configured (`user.name` or
`user.email` unset or empty), it emits a WARN per missing field and prints the `git config` command
to fix it. The check is WARN rather than FAIL because a pull-only host does not need an identity;
the purpose is to catch the gap before a `nomad push` hits a raw git error at commit time. When a
`path-map.json` entry for the current host points at a local directory that no longer exists on
disk, it emits a WARN naming the project and the missing path. Entries for other hosts are not
checked (those paths are legitimately absent on this machine), and `TBD` placeholders are skipped.
Finally, `~/.claude/skills/` gets the same divergence check as per-project extras: if a synced
skill file has been hand-edited after the last pull and differs from the shared copy, `nomad doctor`
lists the differing files before a pull would silently overwrite them. `gsd-*` skills are excluded
from this check, the same as they are excluded from the skills copy-sync.

`nomad pull --dry-run` keeps its own readable preview format (a unified diff of the
`settings.json` changes plus the transcripts a real pull would overwrite) rather than the grouped
tree, so that preview stays easy to scan; only a real `nomad pull` prints the tree above.
`nomad diff` is unchanged.

## Run tests

```bash
$ npm install
$ npx vitest run
```
