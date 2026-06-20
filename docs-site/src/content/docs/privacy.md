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

`nomad doctor` makes a small number of read-only outbound requests. Each is a plain `GET` that
fetches public data and is bounded by a three-second ceiling. None of them send any information about
you or your configuration:

- **npm registry** (`registry.npmjs.org`): reads the latest published claude-nomad version so the
  doctor can warn you when a newer release is available. The version comparison happens locally.
- **JSON Schema Store** (`json.schemastore.org`): fetches the public Claude Code settings schema used
  to validate your local `settings.json`. The validation happens locally.
- **Your Git remote**: a reachability check against the private repository you configured. This is
  your own infrastructure.

Like any HTTP request, these reveal standard connection metadata (such as your IP address) to the
endpoint you contact (npm, the schema store, or your own Git host). That is inherent to making a
network request; it is not collected by claude-nomad or its author. You can run the tool fully
offline, in which case these checks simply report as unavailable.

## The Claude Code plugin

The companion plugin adds slash commands and a session-start hook that shell out to the local
`nomad` CLI. The hook runs `nomad doctor`, so it performs the same outbound checks described above
and nothing more. The plugin introduces no data collection or network activity of its own.

## Changes

This policy may be revised as the tool changes. The authoritative version is the one published with
the current release on this site.
