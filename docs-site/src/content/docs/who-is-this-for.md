---
title: Who is this for
description: The two situations claude-nomad is built for, and who gets the most out of it.
---

claude-nomad is for anyone who uses Claude Code on more than one computer, or is about to. If your
skills, slash commands, settings, and past conversations only live on one machine, this tool moves
them everywhere you work. There are two situations it is built for.

## 1. Migrating to a new machine

You are setting up a new laptop, a fresh workstation, or a remote box, and you want your Claude
Code environment to come with you instead of starting from scratch.

What this means for you: open Claude Code on the new machine and, today, it is a blank slate. None
of your custom agents, tuned settings, slash commands, or earlier conversations are there. With
claude-nomad you push from the old machine once, pull on the new one, and your whole setup lands,
conversation history included. Because Claude Code stores each session under the project's file
path, and that path is usually different on the new machine, claude-nomad rewrites those paths on
the way over so your old sessions are resumable instead of stranded.

This is a one-time move. After the migration you can keep using claude-nomad or stop; nothing on
the old machine is changed or deleted by the migration itself.

## 2. Keeping multiple machines in sync

You regularly work across two or more machines (say a desktop and a laptop, or a work and a home
box) and you want them to stay the same over time, not just once.

What this means for you: run `nomad push` when you finish on one machine and `nomad pull` when you
sit down at the next. Your shared skills, commands, rules, and settings stay identical everywhere,
and a conversation you started on one machine is waiting for you on the other. Per-machine
differences are respected: things like model choice, MCP server URLs, and environment variables
are merged on top of your shared defaults rather than overwriting them, so each machine keeps its
local quirks while sharing everything else.

This is the ongoing case. The two commands become part of your routine, the same way you might
`git pull` at the start of a session and `git push` at the end.

## What it is not

claude-nomad is not a backup tool and not a general dotfiles manager. It syncs Claude Code state
specifically, and it is deliberate about what leaves your machine: credentials and ephemeral
per-host state never sync, only an explicit allow-list of paths is pushed, and everything that does
go up is secret-scanned before it leaves. See [Security](/claude-nomad/security/) for the full picture.

If you only ever use Claude Code on a single machine and never plan to move, you do not need this.

Ready to set up? Head to the [Quickstart](/claude-nomad/quickstart/).
