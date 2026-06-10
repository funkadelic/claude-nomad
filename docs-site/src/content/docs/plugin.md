---
title: Claude Code plugin
description:
  Optional companion plugin that adds /nomad slash commands and a session-start drift check inside
  Claude Code.
---

claude-nomad ships an optional Claude Code plugin. It puts the everyday nomad commands one slash
away inside a Claude Code session, and warns you at session start when your synced setup has drifted.
The plugin is a thin convenience layer: it shells out to the `nomad` binary and adds no sync logic of
its own.

## What you need first

The plugin runs the `nomad` CLI under the hood, so install the CLI before using the plugin:

```sh
npm i -g claude-nomad
```

If `nomad` is not installed, the slash commands fail with a `command not found` error from the shell,
and the session-start check stays silent. So you can enable the plugin everywhere without it
complaining on machines that do not use nomad.

## Install

Add the marketplace catalog, then install the plugin from it:

```text
/plugin marketplace add funkadelic/claude-nomad
/plugin install nomad@claude-nomad
```

If you install it mid-session, run `/reload-plugins` to activate the commands right away.

To try it for a single session without installing, point Claude Code at the plugin directory:

```sh
claude --plugin-dir ./.claude-plugin/nomad-plugin/
```

## Commands

Each command runs the matching CLI subcommand and prints its output back into the session. See the
[full command reference](/claude-nomad/commands/) for what each one does in detail.

| Command         | Runs                      | Notes                                                              |
| --------------- | ------------------------- | ----------------------------------------------------------------- |
| `/nomad:pull`   | `nomad pull`              | Accepts `--dry-run` to preview without applying.                  |
| `/nomad:diff`   | `nomad diff`              | Offline, read-only preview of what a pull would change.           |
| `/nomad:push`   | `nomad push --dry-run`    | Preview only. A real push must run in a terminal (see below).     |
| `/nomad:doctor` | `nomad doctor`            | Read-only health check: symlinks, settings drift, path-map, more. |
| `/nomad:clean`  | `nomad clean --backups`   | Prunes the backup cache. Pass `--keep <N>` to trim recent ones.   |

### Why push is preview-only

A real `nomad push` runs a secret-scanning pipeline and, on a hit, an interactive recovery menu to
redact, allow, or drop the finding. That menu needs a real terminal, which the plugin's I/O context
cannot provide. So `/nomad:push` is limited to `--dry-run`. To push for real, open a terminal and run
`nomad push` directly.

## Session-start drift check

When a Claude Code session starts (including `--resume`, `/clear`, and after a compaction), the
plugin quietly runs `nomad doctor` and surfaces any warnings or failures into the session. If
everything is healthy, it says nothing. The check is read-only, never writes to `~/.claude/`, and
always lets the session start even if doctor reports a problem, so it can never get in your way.
