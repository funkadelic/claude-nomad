---
title: Privacy
description:
  What data the claude-nomad CLI and Claude Code plugin do (and do not) collect, store, and
  transmit.
---

claude-nomad runs entirely on machines you control and the private Git repository you configure. The
project operates no server, no backend, and no analytics, and the author receives no data about you,
your machine, or how you use the tool.

## What is never collected

- No telemetry, analytics, tracking, or usage metrics.
- No account, login, or identifier of any kind.
- The author and the project receive nothing about you or your Claude Code configuration.

## Where your data lives

Your Claude Code configuration and session transcripts sync only between your own machines and the
private Git remote you configure (your `NOMAD_REPO` / GitHub repository). That remote is
infrastructure you own and control. claude-nomad never copies your configuration anywhere else.

## Outbound network requests

`nomad doctor` makes at most two read-only outbound requests. Each is a plain `GET` that fetches
public data and is bounded by a three-second ceiling. Neither sends any information about you or your
configuration:

- **npm registry** (`registry.npmjs.org`): on every run, reads the latest published claude-nomad
  version so the doctor can warn you when a newer release is available. The version comparison
  happens locally.
- **JSON Schema Store** (`json.schemastore.org`): only when you pass `--check-schema`, fetches the
  public Claude Code settings schema used to validate your local `settings.json`. The default
  `nomad doctor`, and the plugin's session-start hook, never makes this request.

The doctor also prints your configured Git remote, but that is a local read of `.git/config` (via
`git remote get-url origin`), not a network request. Sync to that remote happens through `git` only
when you explicitly run `nomad pull` or `nomad push`, against infrastructure you own and control.

Like any HTTP request, the two requests above reveal standard connection metadata (such as your IP
address) to the endpoint you contact (npm or the schema store). That is inherent to making a network
request; it is not collected by claude-nomad or its author. You can run the tool fully offline, in
which case these checks simply report as unavailable.

## The Claude Code plugin

The companion plugin adds slash commands and a session-start hook that shell out to the local
`nomad` CLI. The hook runs the default `nomad doctor`, so its only outbound network request is the
npm version check described above. The plugin introduces no data collection or network activity of
its own.

## Changes

This policy may be revised as the tool changes. The authoritative version is the one published with
the current release on this site.
