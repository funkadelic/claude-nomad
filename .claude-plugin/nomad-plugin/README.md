# claude-nomad Plugin

Companion Claude Code plugin for the standalone
[claude-nomad](https://github.com/funkadelic/claude-nomad) sync CLI. Adds `/nomad:pull`,
`/nomad:push`, `/nomad:doctor`, `/nomad:clean`, and `/nomad:diff` slash commands plus a
`SessionStart` drift-warning hook to any Claude Code session.

## Table of contents

- [Requires the nomad CLI](#requires-the-nomad-cli)
- [Install](#install)
- [Commands](#commands)
- [SessionStart hook](#sessionstart-hook)

## Requires the nomad CLI

The plugin shells out to the `nomad` binary for all operations. It reimplements no sync logic of its
own. Install the standalone CLI separately before using the plugin:

```sh
npm i -g claude-nomad
```

**Minimum version: `>= 0.35.0`.** The plugin versions independently from the CLI (no lockstep
coupling), but it calls recent subcommands (`nomad diff`, `nomad clean --backups`) and relies on the
doctor glyph output format that the session-start hook greps. A CLI older than 0.35.0 makes some
commands error or produce no output. Run `npm i -g claude-nomad` to update to the latest version.

If `nomad` is not on your PATH, the slash commands fail with a shell `command not found` error (they
shell out to `nomad` directly). The SessionStart hook, by contrast, detects the missing binary and
stays silent, so the plugin can be enabled globally without noise on hosts that lack the CLI.

## Install

**Production install (recommended):**

1. Add the marketplace catalog to Claude Code:

   ```text
   /plugin marketplace add funkadelic/claude-nomad
   ```

2. Install the plugin from the catalog:

   ```text
   /plugin install nomad@claude-nomad
   ```

If you install mid-session, run `/reload-plugins` to activate the new commands immediately.

**Local development:**

Load the plugin for a single session without installing it globally:

```sh
claude --plugin-dir ./.claude-plugin/nomad-plugin/
```

## Commands

### `/nomad:pull`

Syncs `~/.claude/` from the shared repo. Equivalent to running `nomad pull` in a terminal. Run this
after switching machines or when another host has pushed an update.

Accepts `--dry-run` to preview changes without applying them.

### `/nomad:diff`

Shows an offline, read-only preview of what a `pull` would change against the current local repo
state. Unlike `/nomad:pull --dry-run`, it takes no lock and touches nothing, so it is safe to run
any time to see whether a pull has pending changes.

### `/nomad:push`

Previews what `nomad push` would sync, using `--dry-run` mode only. A real push requires an
interactive terminal because the secret-scanning pipeline and TTY recovery menu cannot work cleanly
inside the plugin I/O context. To run a real push, open a terminal and run `nomad push` directly.

### `/nomad:doctor`

Runs `nomad doctor` health checks: symlink state, settings drift, path-map validation, gitleaks
probe, and remote reachability. Useful for diagnosing why pull or push is behaving unexpectedly.

### `/nomad:clean`

Prunes the host-local backup snapshots that pull and push accumulate. Runs `nomad clean --backups`.
With no arguments it removes only snapshots older than 14 days, so recent backups are kept. Pass
`--keep <N>` to retain the N newest snapshots instead (useful when recent backups have grown large),
`--older-than <dur>` for a custom age cutoff, or `--dry-run` to preview what would be removed.

## SessionStart hook

When a Claude Code session starts (including `--resume`, `/clear`, and post-compaction), the plugin
runs `nomad doctor` and injects any WARN or FAIL lines into session context. The check runs at
session start and finishes in about two seconds (bounded by a three-second network ceiling). If
everything is clean, the hook outputs nothing. The hook never mutates `~/.claude/` and always exits
0, so a doctor FAIL can never prevent a session from starting.

The hook is also silent when `nomad` is not installed, so the plugin can be enabled globally without
interfering on hosts that do not use the nomad sync workflow.
