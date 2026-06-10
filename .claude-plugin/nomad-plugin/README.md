# claude-nomad Plugin

Companion Claude Code plugin for the standalone
[claude-nomad](https://github.com/funkadelic/claude-nomad) sync CLI. Adds `/nomad:pull`,
`/nomad:push`, and `/nomad:doctor` slash commands plus a `SessionStart` drift-warning hook to any
Claude Code session.

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

If `nomad` is not on your PATH, the slash commands print a graceful install hint instead of running.
The SessionStart hook stays silent on hosts where `nomad` is not installed.

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

### `/nomad:push`

Previews what `nomad push` would sync, using `--dry-run` mode only. A real push requires an
interactive terminal because the secret-scanning pipeline and TTY recovery menu cannot work cleanly
inside the plugin I/O context. To run a real push, open a terminal and run `nomad push` directly.

### `/nomad:doctor`

Runs `nomad doctor` health checks: symlink state, settings drift, path-map validation, gitleaks
probe, and remote reachability. Useful for diagnosing why pull or push is behaving unexpectedly.

## SessionStart hook

When a Claude Code session starts (including `--resume`, `/clear`, and post-compaction), the plugin
runs `nomad doctor` in the background and injects any WARN or FAIL lines into session context. If
everything is clean, the hook outputs nothing. The hook never mutates `~/.claude/` and always exits
0, so a doctor FAIL can never prevent a session from starting.

The hook is also silent when `nomad` is not installed, so the plugin can be enabled globally without
interfering on hosts that do not use the nomad sync workflow.
