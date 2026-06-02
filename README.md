# claude-nomad

[![tests](https://img.shields.io/github/actions/workflow/status/funkadelic/claude-nomad/tests.yml?branch=main&label=tests)](https://github.com/funkadelic/claude-nomad/actions/workflows/tests.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/funkadelic/claude-nomad/codeql.yml?branch=main&label=codeql)](https://github.com/funkadelic/claude-nomad/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/funkadelic/claude-nomad/graph/badge.svg?token=5NML626POS)](https://codecov.io/gh/funkadelic/claude-nomad)
[![NPM Version](https://img.shields.io/npm/v/claude-nomad?logo=npm)](https://www.npmjs.com/package/claude-nomad)
[![node](https://img.shields.io/node/v/claude-nomad?logo=nodedotjs)](https://www.npmjs.com/package/claude-nomad)
[![license](https://img.shields.io/npm/l/claude-nomad)](LICENSE)

![claude-nomad - Sync your Claude Code setup. Same environment. Any machine.](docs/hero.svg)

**Your entire Claude Code setup, on every machine. History included, every push secret-scanned.**

Open Claude Code on a second machine and it is a blank slate: none of your custom agents, slash
commands, tuned settings, or past conversations. **claude-nomad** keeps all of it in sync through a
private Git repo you control. `nomad push` on one machine, `nomad pull` on the next, and everything
is there, conversations included.

Not dotfiles, not rsync. **claude-nomad** understands Claude Code's state, so your session history
survives different file paths and your secrets never ride along.

**Full documentation: <https://funkadelic.github.io/claude-nomad/>**

## Quickstart

**First host** (once, ever):

```bash
# 1. Install the CLI.
$ npm i -g claude-nomad

# 2. Create your private sync repo and scaffold it.
$ nomad init                   # prompts for a repo name (default: claude-nomad-config)
$ nomad init --repo my-config  # non-interactive

# 3. Add a stable host label to ~/.zshrc or ~/.bashrc, then reload.
export NOMAD_HOST=<your-host-label>

# 4. Publish the scaffold to your private repo.
$ nomad push
```

**Each additional host:**

```bash
$ npm i -g claude-nomad
$ gh repo clone <your-username>/claude-nomad-config ~/claude-nomad
export NOMAD_HOST=<your-host-label>   # add to ~/.zshrc or ~/.bashrc
$ nomad pull
```

Everyday loop on any host:

```bash
$ nomad doctor   # confirm setup
$ nomad pull     # apply config to ~/.claude/
$ nomad push     # publish local changes (sessions, settings)
```

When `nomad push` detects a potential secret, it drops into an interactive menu (TTY) or aborts with
a recovery hint (non-TTY/CI). Three non-interactive recovery paths are available without the menu:

- `nomad push --redact-all` -- scrub every finding from the local transcript in place, then push.
- `nomad push --allow <rule>` -- record findings matching one gitleaks rule id as false positives
  (appends their fingerprints to `.gitleaksignore`), then re-scan and push.
- `nomad push --allow-all` -- record every current finding as a false positive, then re-scan and
  push.
- `nomad allow <fingerprint>...` -- pre-record specific fingerprints in `.gitleaksignore` without
  going through a push cycle.

All allow paths always re-scan after writing the allowlist; a surviving finding still aborts the
push. See [Recovery flows](https://funkadelic.github.io/claude-nomad/recovery/) for the full
decision tree.

## Requirements

- Node.js 22.22.1 or newer (24 LTS recommended)
- Git
- [`gitleaks`](https://github.com/gitleaks/gitleaks) (required for `nomad push`)
- `gh` ([GitHub CLI](https://cli.github.com/)), required by `nomad init`

**Optional:** [curl](https://curl.se/) or [wget](https://www.gnu.org/software/wget/) for the
version-staleness check and `nomad doctor --check-schema`. The CLI works without them.

## Learn more

- [How it works](https://funkadelic.github.io/claude-nomad/how-it-works/) -- path remapping,
  settings merge, what syncs and what doesn't
- [Setup and migration](https://funkadelic.github.io/claude-nomad/quickstart/) -- full setup
  walkthrough, migrating an existing `~/.claude/`
- [Commands reference](https://funkadelic.github.io/claude-nomad/commands/) -- all CLI flags
- [Recovery flows](https://funkadelic.github.io/claude-nomad/recovery/) -- backups, drop-session,
  redact, gitleaks allowlist, non-interactive allow
- [Contributing](https://funkadelic.github.io/claude-nomad/contributing/)
- [Security policy](https://funkadelic.github.io/claude-nomad/security/)
