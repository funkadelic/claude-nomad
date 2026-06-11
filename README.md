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

## Features

- **Sessions follow you across machines.** Start a conversation on your desktop, run
  `claude --resume` on your laptop, and it is there. claude-nomad rewrites the machine-specific file
  paths Claude Code embeds in every transcript, so history survives projects living at different
  paths on different hosts.
- **One shared setup, per-machine exceptions.** Your own skills, slash commands, rules, and your
  `CLAUDE.md` live in one place and follow you everywhere. `hooks/` and `agents/` are installed
  per-host by `@opengsd/gsd-core` via npm and are not synced (syncing them caused version-skew
  churn). Skills sync as a filtered copy: your own skills travel, `gsd-*` skills are excluded (see
  `SHARED_LINKS` and `src/skills-sync.ts` in `src/config.ts`). Settings merge a shared base with a
  per-host override, so one machine can run a different model or MCP URL without forking the rest.
- **Every push is secret-scanned.** Only an explicit allow-list of paths ever leaves the machine,
  credentials never sync, and gitleaks scans the exact files about to be published. The push aborts
  on any hit, with an interactive menu to redact, allow, or drop the finding.
- **Preview before you trust it.** `nomad diff` shows offline what a pull would change, and
  `--dry-run` on pull and push prints the plan without writing anything.
- **One command tells you what is wrong.** `nomad doctor` is a read-only health check: wedged sync
  repo, broken hook references, hooks that would crash on session start because of a missing
  `--preserve-symlinks-main` flag, version drift, oversized backup cache, and settings drift (warns
  when `~/.claude/settings.json` no longer matches the base+host merge nomad would write, the
  silent-clobber case, with `nomad pull` as the fix), each with a fix hint.
- **Self-healing sync.** Every overwrite is backed up first, and `nomad pull --force-remote`
  recovers a sync repo stuck mid-rebase while parking your stranded work on a branch, refusing
  entirely if shared config is at risk.
- **Easy off.** `nomad eject` replaces every managed `~/.claude/` symlink with a real copy in one
  step, so your setup keeps working after you delete the sync checkout and uninstall the CLI.

See the [full feature tour](https://funkadelic.github.io/claude-nomad/features/) for the rest:
opt-in per-project sync, transcript redaction, backup pruning, and more.

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

During `nomad push` and `nomad pull`, long-running steps (rebase, secret scan, git push, session
sync) show an animated progress indicator on an interactive terminal so the CLI does not look hung.
In CI and when output is piped, only plain text lines are printed, with no ANSI control codes, so
log output remains grep-stable.

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

If a previous `nomad pull` left the sync repo stuck mid-rebase or mid-merge, run
`nomad pull --force-remote` to auto-recover. It aborts the in-progress operation, parks stranded
commits on a `nomad/stranded-<ts>` branch, and resets to `origin/main`, then re-pulls. It refuses if
any stranded or dirty tracked changes touch synced config (shared/, hosts/, path-map.json), so
config you care about is never silently discarded.

## Claude Code plugin

An optional companion plugin puts nomad one slash away inside Claude Code and warns you at session
start when your synced setup has drifted. It is a thin layer over the CLI: install `claude-nomad`
first, then add the plugin.

```text
/plugin marketplace add funkadelic/claude-nomad
/plugin install nomad@claude-nomad
```

It adds `/nomad:pull`, `/nomad:diff`, `/nomad:push` (preview only), `/nomad:doctor`, and
`/nomad:clean`, plus a session-start drift check. See the
[plugin guide](https://funkadelic.github.io/claude-nomad/plugin/) for details.

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
- [Claude Code plugin](https://funkadelic.github.io/claude-nomad/plugin/) -- /nomad slash commands
  and the session-start drift check
- [Recovery flows](https://funkadelic.github.io/claude-nomad/recovery/) -- backups, drop-session,
  redact, gitleaks allowlist, non-interactive allow
- [FAQ](https://funkadelic.github.io/claude-nomad/faq/) -- common questions, like the right
  push/pull order when both sides have changes
- [Contributing](https://funkadelic.github.io/claude-nomad/contributing/)
- [Security policy](https://funkadelic.github.io/claude-nomad/security/)
