---
title: claude-nomad
description: Sync your Claude Code config across machines.
template: splash
hero:
  tagline: Sync your Claude Code config across machines.
  actions:
    - text: Quickstart
      link: /claude-nomad/quickstart/
      icon: right-arrow
    - text: Commands reference
      link: /claude-nomad/commands/
      variant: minimal
---

**Your entire Claude Code setup, on every machine. History included, every push secret-scanned.**

Open Claude Code on a second machine and it is a blank slate: none of your custom agents, slash
commands, tuned settings, or past conversations. **claude-nomad** keeps all of it in sync through
a private Git repo you control. `nomad push` on one machine, `nomad pull` on the next, and
everything is there, conversations included.

- **Resume your Claude Code sessions on any machine.** Start a conversation on your desktop and
  pick it up on your laptop. **claude-nomad** remaps the file paths Claude Code embeds in every
  transcript, so your history follows you instead of getting stranded on the box where it started.
- **Secret-scanned, private by default.** Your `~/.claude/` holds OAuth tokens, MCP credentials,
  and the full text of every conversation, so **claude-nomad** is deliberate about what leaves your
  machine: credentials and ephemeral state never sync, only an explicit allow-list of paths is
  pushed, and everything that does go up is scanned by
  [gitleaks](https://github.com/gitleaks/gitleaks) before it leaves; the push aborts on any hit.
- **One setup, every machine.** Your agents, skills, slash commands, and settings live in one
  place and follow you everywhere. Per-machine tweaks like model choice, MCP URLs, and env vars
  merge on top instead of clobbering your shared defaults.

Not dotfiles, not rsync. **claude-nomad** understands Claude Code's state, so your session history
survives different file paths and your secrets never ride along.
