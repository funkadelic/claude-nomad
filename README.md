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

- **Resume your Claude Code [sessions](https://code.claude.com/docs/en/agent-sdk/sessions) on any
  machine.** Start a conversation on your desktop and pick it up on your laptop. **claude-nomad**
  remaps the file paths Claude Code embeds in every transcript, so your history follows you instead
  of getting stranded on the box where it started.
- **Secret-scanned, private by default.** Your `~/.claude/` also holds OAuth tokens, MCP
  credentials, and the full text of every conversation, so **claude-nomad** is deliberate about what
  leaves your machine: credentials and ephemeral state never sync, only an explicit allow-list of
  paths is pushed, and everything that does go up is scanned by
  [gitleaks](https://github.com/gitleaks/gitleaks) before it leaves your machine; the push aborts on
  any hit. `nomad init` also disables Actions on your private mirror by default, so transcripts
  can't leak through CI logs.
- **One setup, every machine.** Your agents, skills, slash commands, and settings live in one place
  and follow you everywhere. Per-machine tweaks like model choice, MCP URLs, and env vars merge on
  top instead of clobbering your shared defaults.

Not dotfiles, not rsync. **claude-nomad** understands Claude Code's state, so your session history
survives different file paths and your secrets never ride along.

For anyone running Claude Code on more than one machine: a laptop and a desktop, a Mac and a WSL
box, a personal rig and a work machine. [Get started in three steps.](#quickstart)

## Table of contents

- [Quickstart](#quickstart)
- **Concepts**
  - [How it works](#how-it-works)
  - [Repo layout](#repo-layout-what-claude-nomad-looks-like-on-a-configured-host)
  - [What gets synced vs. not](#what-gets-synced-vs-not)
  - [Path remapping](#path-remapping)
  - [Shared support dirs (sharedDirs)](#shared-support-dirs-shareddirs)
  - [Per-host overrides](#per-host-overrides)
  - [What does NOT sync (deliberate trade-offs)](#what-does-not-sync-deliberate-trade-offs)
- **Getting started**
  - [Requirements](#requirements)
  - [Setup](#setup)
    - [Privacy by default](#privacy-by-default)
    - [First host](#first-host)
    - [Each additional host](#each-additional-host)
  - [Migrating an existing ~/.claude/](#migrating-an-existing-claude)
  - [Upgrading the CLI](#upgrading-the-cli)
- **Reference**
  - [Commands](#commands)
  - [Recovery flows](#recovery-flows)
    - [Pruning old backups](#pruning-old-backups)
    - [`nomad drop-session <id>`](#nomad-drop-session-id)
    - [`nomad redact <session-id>`](#nomad-redact-session-id)
    - [Recovery flow: gitleaks FATAL on a session JSONL](#recovery-flow-gitleaks-fatal-on-a-session-jsonl)
    - [Recovery flow: push-time interactive menu](#recovery-flow-push-time-interactive-menu)
    - [`.gitleaks.toml` allowlist policy](#gitleakstoml-allowlist-policy)
      - [Customizing the allowlist with an overlay](#customizing-the-allowlist-with-an-overlay)
  - [Cross-OS resume](#cross-os-resume)
  - [Run tests](#run-tests)

## Quickstart

**First host** (once, ever):

```bash
# 1. Install the CLI.
$ npm i -g claude-nomad

# 2. Create your private sync repo and scaffold it. nomad init uses gh to
#    create the repo, wire origin, and disable Actions, then scaffolds locally.
$ nomad init                   # prompts for a repo name (default: claude-nomad-config)
$ nomad init --repo my-config  # non-interactive: use this name, no prompt

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

Then the everyday loop on any host:

```bash
$ nomad doctor   # confirm setup
$ nomad pull     # apply config to ~/.claude/
$ nomad push     # publish local changes (sessions, settings)
```

Full walkthrough and the safe-migration sequence for a populated `~/.claude/` are in [Setup](#setup)
and [Migrating an existing ~/.claude/](#migrating-an-existing-claude).

## How it works

**claude-nomad** is a **tool**, not a config store. You install the CLI globally
(`npm i -g claude-nomad`) and keep a separate **private** Git repo that holds only your config:
`CLAUDE.md`, agents, skills, settings, session transcripts. No tool source code lives in that repo.

```text
your private <your-username>/claude-nomad-config
  ├── shared/                 (your config, synced to every host)
  │   ├── CLAUDE.md
  │   ├── agents/
  │   ├── skills/
  │   ├── commands/
  │   ├── rules/
  │   ├── hooks/
  │   ├── settings.base.json
  │   └── projects/
  ├── hosts/<hostname>.json
  └── path-map.json
```

`nomad init` creates this repo for you (via `gh`) and scaffolds the directory structure in one step.
Every host after the first installs the CLI, clones your private data repo to `~/claude-nomad/`, and
runs `nomad pull` to sync.

By default the CLI operates on `~/claude-nomad/` (see `REPO_HOME` in `src/config.ts`). Developers
working from an alternate checkout can `export NOMAD_REPO=/path/to/repo` to point the CLI at their
working tree without symlink gymnastics; `nomad doctor` surfaces an active override via a trailing
`(NOMAD_REPO)` annotation on the repo-state line. Empty `NOMAD_REPO` falls through to the default,
so a clobbered dotfile variable does not break the CLI.

## Repo layout (what `~/claude-nomad/` looks like on a configured host)

```text
~/claude-nomad/
├── shared/                   # synced to every machine
│   ├── CLAUDE.md
│   ├── settings.base.json    # baseline settings
│   ├── agents/
│   ├── skills/
│   ├── commands/
│   ├── rules/
│   ├── hooks/                # hook scripts, symlinked into ~/.claude/hooks/
│   ├── my-statusline.cjs     # any script you want symlinked into ~/.claude/
│   ├── .gitignore            # defense-in-depth: blocks .claude.json, settings.local.json, *.token, *.key, *.pem, id_rsa, id_ed25519, .env, .env.*
│   ├── projects/             # session transcripts under logical names
│   └── extras/               # opt-in per-project content (materializes when path-map.json declares extras)
├── hosts/
│   ├── <your-mac>.json       # patches merged over settings.base.json
│   ├── <your-wsl-host>.json
│   └── <your-nuc>.json
└── path-map.json             # logical project -> per-host absolute path
```

## What gets synced vs. not

| Category                | Items                                                                                   | Behavior                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Synced**              | `CLAUDE.md`, `agents/`, `skills/`, `commands/`, `rules/`, `hooks/`, `my-statusline.cjs` | Symlinked into `~/.claude/` from `shared/`.                                                                                                                   |
| **Generated**           | `settings.json`                                                                         | Deep-merge of `settings.base.json` with `hosts/<hostname>.json`; rewritten every pull.                                                                        |
| **Remapped**            | `projects/` session transcripts                                                         | Copied with path translation per `path-map.json`.                                                                                                             |
| **Per-project extras**  | Whitelisted dirs like `.planning/`, or a root file like `CLAUDE.md`                     | Opt-in via the `extras` field in `path-map.json`; mirrored to/from `shared/extras/<logical>/`.                                                                |
| **Shared support dirs** | Opt-in global `~/.claude/` dirs like a tool's `get-shit-done/`                          | Opt-in via the `sharedDirs` field in `path-map.json`; symlinked into `~/.claude/` from `shared/`. See [Shared support dirs](#shared-support-dirs-shareddirs). |
| **Never synced**        | OAuth and MCP state, shell history, per-host overrides, caches, scratch dirs            | Per-host ephemeral state; left untouched in both directions.                                                                                                  |
| **Auto-rehydrated**     | `~/.claude/plugins/cache/<plugin>/...`                                                  | Re-downloaded by Claude Code from the `enabledPlugins` list; no per-host install.                                                                             |

Pointers and specifics:

- **Synced** link names live in `SHARED_LINKS` (and the optional `sharedDirs` field in
  `path-map.json` -- see [Shared support dirs](#shared-support-dirs-shareddirs)), **whitelisted
  extras** names in `SUPPORTED_EXTRAS`, and the full **never-synced** set in `NEVER_SYNC` (all in
  `src/config.ts`).
- **Never synced**, in full: `~/.claude.json` (OAuth, MCP state), `.credentials.json` (OAuth
  credential store), `history.jsonl`, `settings.local.json` (per-host overrides),
  `stats-cache.json`, `todos/`, `shell-snapshots/`, `debug/`, `file-history/`, `plans/`,
  `session-env/`, `statsig/`, `telemetry/`, `ide/`, plus host-local caches and runtime state
  (`cache/`, `backups/`, `paste-cache/`, `daemon/`, `jobs/`, `tasks/`, `security/`, `sessions/`).
  This set is also the deny-list the `sharedDirs` opt-in is checked against, so one of these names
  cannot be symlinked into the shared repo by mistake.
- **Per-project extras** run a pre-pull divergence WARN that flags local edits before they get
  overwritten.

<!-- prettier-ignore -->
> [!NOTE]
> Plugins that depend on host-specific state (external binaries, API keys in env, MCP server
> URLs) still need that side set up on each host. Put them in `hosts/<host>.json` or the plugin's
> own per-host config.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Syncing a tool's `skills/` or `commands/` files copies the command shims, not the engine behind
> them. If a tool keeps a binary or runtime outside `~/.claude/` (installed with `npm i -g`, a setup
> script, and so on), nomad does not carry that part, so the synced commands appear on a new host but
> fail until the tool itself is installed there. Install such tools once per host. For example, if you
> sync the GSD (`get-shit-done`) skills, run `npm i -g get-shit-done-cc` on each host, pinned to the
> version that matches your committed skills. Claude Code marketplace plugins (such as superpowers)
> are the exception: they are listed in `enabledPlugins`, synced via `settings.base.json`, and
> re-downloaded by Claude Code automatically, so they need no manual install.

For the rationale behind these choices, see
[What does NOT sync (deliberate trade-offs)](#what-does-not-sync-deliberate-trade-offs).

## Path remapping

The hard problem: Claude Code stores sessions in `~/.claude/projects/<encoded-path>/` where the
encoded path is the absolute path with `/` replaced by `-`. So the same logical project ends up in
different directories on each host.

`path-map.json` defines logical names and where the repo lives on each host. The optional `extras`
block opts a project into syncing whitelisted directories (or a single root file) at its root:

```json
{
  "projects": {
    "my-example-repo": {
      "<your-mac>": "/Users/you/code/my-example-repo",
      "<your-wsl-host>": "/home/you/code/my-example-repo",
      "<your-nuc>": "TBD"
    }
  },
  "extras": {
    "my-example-repo": [".planning", "CLAUDE.md"]
  }
}
```

<!-- prettier-ignore -->
> [!IMPORTANT]
> The host-label keys must match whatever you set `NOMAD_HOST=` to on each host (see
> [Setup](#setup)). Mismatched labels silently skip remap, so sessions land in the wrong host's
> encoded dir.

Use the literal string `"TBD"` for hosts you haven't onboarded yet; `remapPull` skips TBD entries
cleanly instead of creating an orphan `~/.claude/projects/TBD/`. Replace each `"TBD"` with the real
path when you bring up that host.

On `push`, sessions in `~/.claude/projects/-Users-you-code-my-example-repo/` get copied to
`shared/projects/my-example-repo/`. On `nomad pull` on another machine, they get copied to that
host's encoded path. `claude --resume` then finds them (see
[What does NOT sync (deliberate trade-offs)](#what-does-not-sync-deliberate-trade-offs) for the
cross-OS cwd-binding gotcha).

The `extras` block is additive and back-compatible: legacy `path-map.json` files without it keep
working unchanged. Each value is an array of directory or root-file names (e.g. `.planning`,
`CLAUDE.md`) checked against `SUPPORTED_EXTRAS` in `src/config.ts`; anything outside that whitelist
is skipped with a log line, so an unrecognized name cannot widen the sync surface.

On `nomad push`, opted-in content at `<localRoot>/<name>` (a directory subtree or a single file) is
copied to `shared/extras/<logical>/<name>` and goes through the same staged-tree gitleaks scan as
everything else. On `nomad pull`, the reverse copy runs after `git pull --rebase`, and just before
it overwrites your working tree a divergence check compares the incoming content against your local
copy and prints a per-file WARN naming anything that differs.

Your existing local content is backed up under `~/.cache/claude-nomad/backup/<ts>/extras/` before
the pull copy lands, so an unexpected overwrite is always recoverable.

## Shared support dirs (sharedDirs)

Some tools install a `hooks` block into `settings.json` whose commands point at scripts under
`~/.claude/hooks/` (and sometimes a support directory such as `~/.claude/get-shit-done/`). Because
`settings.json` is regenerated on every pull, that hook configuration travels to every host, but the
scripts it points at did not, so hooks broke on a freshly configured host. `~/.claude/hooks/` is now
a built-in synced link (it rides the same symlink model as `skills/` and `agents/`), so hook scripts
travel automatically.

For any other global `~/.claude/` support directory a tool needs, the optional top-level
`sharedDirs` field in `path-map.json` opts it into the same symlink sync:

```json
{
  "projects": {
    "my-example-repo": {
      "<your-mac>": "/Users/you/code/my-example-repo"
    }
  },
  "sharedDirs": ["get-shit-done"]
}
```

What this means for you: each listed name is symlinked from `shared/<name>` into `~/.claude/<name>`
(the same model as the built-in synced links, not a copy), so editing it on any host updates the one
shared copy. The field is additive and back-compatible: a `path-map.json` without it behaves exactly
as before.

Entries are validated before anything is linked. A name is accepted only if it is a single path
segment (no `/`, no `..`), is not one of the never-synced names, and does not collide with a
reserved `shared/` name (`settings.base.json`, the built-in synced links, `hooks`, `hosts`,
`path-map.json`). An invalid entry is dropped with a warning rather than aborting the run. The
contents still go through the same gitleaks scan as everything else on push, so do not point
`sharedDirs` at a directory that holds credentials.

First-time setup on an already-configured repo: a symlink can only form once the directory exists
under `shared/`. On a fresh repo `nomad init --snapshot` handles this for you. To add `hooks/` (or a
new `sharedDirs` entry) to a repo that is already set up, move it into `shared/` once on the host
that has it, then let the normal flow take over:

```bash
$ mv ~/.claude/hooks ~/claude-nomad/shared/hooks   # one-time, on the source host
$ nomad pull                                        # re-creates ~/.claude/hooks as a symlink
$ nomad push                                        # shares it with your other hosts
```

`nomad pull` never writes back to the remote, so it will not seed `shared/` for you; the one-time
move is deliberate.

## Per-host overrides

`settings.base.json` holds portable defaults (model, permissions, plugins).
`hosts/<NOMAD_HOST>.json` holds machine-specific patches. They're deep-merged on every pull (scalars
override, objects merge recursively, arrays replace). Keys that used to be force-marked per-host
because they embedded absolute paths (`statusLine.command`, `hooks`) can live in
`settings.base.json` if you write the commands with `$HOME` (e.g.
`"command": "node \"$HOME/.claude/my-statusline.cjs\""`); Claude Code runs them through a shell so
shell expansion applies. Reserve per-host files for truly machine-specific values (env, MCP URLs,
host-only model overrides).

`shared/settings.base.json`:

```json
{
  "model": "claude-sonnet-4-6",
  "permissions": { "allow": ["Bash(npm run *)", "Bash(git status)"] }
}
```

`hosts/<your-other-host>.json`:

```json
{
  "model": "claude-opus-4-8",
  "env": { "OLLAMA_HOST": "http://localhost:11434" }
}
```

Results on `your-other-host`: opus 4.8, the local Ollama env var, plus the shared permissions array.

<!-- prettier-ignore -->
> [!CAUTION]
> Never hand-edit `~/.claude/settings.json` on a synced host. It's regenerated on every
> `nomad pull` from base + host, so your edits will be clobbered. Edit the base or host file in the
> repo instead.

`nomad doctor` warns when `settings.json` carries a top-level key it does not recognize (a cue that
Claude Code added a setting). The recognized set is kept current against Claude Code's published
settings schema by a weekly automated PR in the public repo, so a periodic `nomad update` (to get
the latest CLI) is what keeps that warning quiet on your hosts. To check your own `settings.json`
against the live schema on demand, run `nomad doctor --check-schema`.

## What does NOT sync (deliberate trade-offs)

Read these before adopting so you opt in with eyes open.

- **Last-write-wins on conflicts.** Git surfaces them on merge; no field-level JSON merging.
- **Manual push/pull.** No file watcher. Shell hooks recommended.
- **OAuth doesn't sync.** You'll log in once per host. Intentional.
- **Only sessions in `path-map.json` are remapped.** Drive-by sessions on un-mapped paths are left
  alone.
- **Extras are opt-in and whitelisted.** Projects without an `extras` entry in `path-map.json` are
  unaffected. Names (a directory or a single root file) outside `SUPPORTED_EXTRAS` are skipped with
  a `skip ... not in SUPPORTED_EXTRAS` log line so an unrecognized name cannot widen the sync
  surface. Unsafe path-map values (path-traversal in `logical` keys, non-absolute or unnormalized
  `localRoot` values) abort the run before any file is touched, so a malformed entry fails loudly
  instead of corrupting state.
- **Cross-OS `claude --resume` cwd binding.** Sessions embed the cwd where they were created, so
  Claude Code's picker's `cd ... && claude --resume <id>` line fails on a different host. Use
  `nomad doctor --resume-cmd <id>` for a host-local equivalent (see
  [Cross-OS resume](#cross-os-resume)). The sidecar approach preserves transcript byte-equality.
- **Empty directories don't survive sync.** Git doesn't track empty dirs; `nomad doctor` reports
  them as `missing` (benign). Drop a `.gitkeep` to force materialization.

## Requirements

- Node.js 22.22.1 or newer (24 LTS recommended; the npm `engines` field declares the 22.22.1 floor
  and surfaces a warning on older runtimes - npm only blocks the install when `engine-strict=true`
  is configured)
- Git
- [`gitleaks`](https://github.com/gitleaks/gitleaks) (required for `nomad push`, which exits with an
  error if it is not on PATH; `nomad doctor` also checks it against the pinned 8.30.x and warns when
  it is absent or mismatched)
- `gh` ([GitHub CLI](https://cli.github.com/)), required by `nomad init` to create and wire the
  private sync repo. When `gh` is missing or unauthenticated, `nomad init` exits with a FATAL and
  shows install / `gh auth login` guidance. On hosts where the private repo is already set up (all
  subsequent hosts), `gh` is only needed by `nomad doctor`'s Actions-drift check and auto-disable;
  pull and push work without it.

**Optional:**

- [curl](https://curl.se/) or [wget](https://www.gnu.org/software/wget/), the HTTP fetcher behind
  the version-staleness check (`nomad doctor` latest-release line) and
  `nomad doctor --check-schema`. curl is tried first and wget is the fallback, so either one works.
  The checks soft-skip (no error, no exit-code change) when neither is present, so the rest of the
  CLI works without it; `nomad doctor` shows a single "HTTP fetcher (curl or wget)" row that is OK
  when either is installed and warns only when both are absent.

## Setup

### Privacy by default

Your private sync repo must stay private. Session transcripts contain the full text of your
conversations. `nomad init` disables Actions on the new repo as soon as it is created, via the
GitHub API call `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false`. What this
means for you: CI workflows (which could echo transcript content into build logs) are turned off on
your private data repo automatically; you do not need to remember to do it.

Pass `--keep-actions` to skip the disable step (for example, when your org already enforces an
Actions policy).

<!-- prettier-ignore -->
> [!WARNING]
> If you ever make the repo public, your session transcripts (which include conversation content)
> become world-readable. **Keep it private.**

### First host

`nomad init` creates the private repo via `gh`, wires it as `origin`, disables Actions, scaffolds
the directory layout, and pushes. The `gh` CLI must be installed and authenticated before you run
it.

```bash
# Install the CLI.
$ npm i -g claude-nomad

# Create the private sync repo and scaffold it. You will be prompted for a
# repo name (default: claude-nomad-config). Pass --repo to skip the prompt.
$ nomad init
# or non-interactively:
$ nomad init --repo my-config

# If ~/.claude/ is already populated on this host, capture it as the starting
# point instead of an empty scaffold. Stages shared/ and writes
# hosts/<NOMAD_HOST>.json from your current ~/.claude/settings.json.
# Does NOT touch the originals.
$ nomad init --snapshot
```

`nomad init` refuses to clobber existing scaffold artifacts, so re-running on a populated repo is a
safe no-op (it errors out naming the offender). `nomad pull` against an unscaffolded repo fails fast
with `FATAL: repo not initialized; run 'nomad init' to scaffold` instead of silently leaving a
half-state.

Add a stable host label to your shell rc, then reload it:

```bash
export NOMAD_HOST=<your-host-label>   # add to ~/.zshrc or ~/.bashrc
```

`NOMAD_HOST` overrides `os.hostname()`, which returns noisy values like `WINDOWS-I5NT6OH` on WSL or
`<name>.local` on macOS. Pick a clean label per machine (e.g., `wsl-laptop`, `macbook`,
`homelab-nuc`). `nomad doctor` reports the resolved host so you can confirm.

Edit `path-map.json` to add your logical projects (see [Path remapping](#path-remapping)), then:

```bash
$ nomad doctor                # read-only state check; reports host, repo state, every check as ✓ (pass) / ✗ (fail) / ⚠︎ (warn)
$ nomad doctor --check-shared # read-only gitleaks preflight over the session transcripts a push would stage
$ nomad diff                  # preview what nomad pull would change on this host; no lock, no network, no mutation
$ nomad push                  # send current state to the private remote
$ nomad pull                  # apply on another host (or this one after a remote update)
```

`nomad pull --dry-run` is the network-aware twin of `nomad diff`: it acquires the lock and runs
`git pull` so you see what the next real pull would do given the latest remote, then exits without
mutating.

If the destination host already has populated `~/.claude/{CLAUDE.md, agents/, ...}`, the first
`nomad pull` will refuse to overwrite real files. See
[Migrating an existing ~/.claude/](#migrating-an-existing-claude) for the safe migration flow.

### Each additional host

```bash
# Install the CLI.
$ npm i -g claude-nomad

# Clone your private data repo.
$ gh repo clone <your-username>/claude-nomad-config ~/claude-nomad
# or with plain git:
$ git clone git@github.com:<your-username>/claude-nomad-config.git ~/claude-nomad

# Add to ~/.zshrc or ~/.bashrc, then reload.
export NOMAD_HOST=<your-host-label>

$ nomad pull   # apply config to ~/.claude/
```

`npm i -g claude-nomad` puts a `nomad` binary on your PATH. What this means for you: there is no
compile step, no extra transpiler to install, and nothing is fetched from the network the first time
you run `nomad`, so the first run works offline. (The Node version floor and the `engine-strict`
caveat are in [Requirements](#requirements).)

## Migrating an existing ~/.claude/

If a host already has real files at `~/.claude/{CLAUDE.md, agents/, skills/, ...}` and you want to
bring them into the sync, the required sequence is `nomad init --snapshot` → `nomad push` →
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
renamed into `~/.cache/claude-nomad/backup/<ts>/` first, then the symlink is created. Your originals
are preserved under that timestamped backup directory, not deleted. Paths whose `shared/<name>` is
absent from the remote are left untouched, so a partial publish does not delete data on the
destination host.

If the remote has not been populated yet (you skipped `nomad init --snapshot` and `nomad push`),
`nomad pull` is a no-op for SHARED_LINKS: there is nothing on the remote to symlink against, so your
local `~/.claude/` files stay in place. The auto-move only triggers once the canonical state is
published.

Prefer an explicit tarball rollback and a confirmation prompt before any deletion? Write the
equivalent under `scripts/`: tar the `SHARED_LINKS` entries under `~/.claude/` first, copy into
`shared/`, prompt, then `nomad pull`. The auto-move path above is the recommended default.

## Upgrading the CLI

`nomad update` updates the `nomad` binary from npm:

```bash
$ nomad update
```

What this means for you: it runs `npm update -g claude-nomad` and refreshes the binary on your PATH.
It does NOT pull your sync data; run `nomad pull` separately when you want to apply remote changes
to this host.

`nomad doctor` reports when your local install is behind the latest npm release:
`⚠︎ claude-nomad: <local> -> <latest> (run nomad update)`.

## Commands

| Command                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nomad init`                     | Create a private GitHub repo via `gh`, wire it as `origin`, disable Actions, scaffold `shared/`, `hosts/`, `path-map.json`, and push. Prompts for a repo name (default: `claude-nomad-config`). `gh` must be installed and authenticated; exits with FATAL otherwise. Refuses to clobber existing scaffold. See [Privacy by default](#privacy-by-default).                                                                                                                                                                                                                                                                                                                          |
| `nomad init --repo <name>`       | Non-interactive: use `<name>` as the private repo name without prompting. Useful in scripts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `nomad init --snapshot`          | Overlay current host's `~/.claude/` into `shared/` and write `~/.claude/settings.json` verbatim into `hosts/<NOMAD_HOST>.json`. Originals not modified. Same auto-disable behavior as `nomad init`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `nomad init --keep-actions`      | Skip the Actions-disable step. Combinable with `--snapshot` and `--repo`. Use when an org policy already governs Actions, or you intentionally want CI on the private repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `nomad pull`                     | `git pull --rebase --autostash`, apply symlinks, regenerate `settings.json`, remap session paths, and pull opted-in per-project extras. Errors out if scaffold missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nomad pull --dry-run`           | Network-aware preview: acquire lock + `git pull --rebase`, print planned changes (symlink moves, `settings.json` diff, transcript overwrites), exit without writing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `nomad diff`                     | Offline, lockless twin of `pull --dry-run`. No network, no lock. Works against the current local repo state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `nomad push`                     | Export local sessions and opted-in per-project extras to logical names, commit (`chore: sync from <NOMAD_HOST>`), push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nomad push --dry-run`           | Run pre-push safety checks (gitleaks probe, rebase, remap preview, gitlink scan, allow-list) and a read-only gitleaks leak preview over a throwaway temp copy of the sessions and extras this host would stage; skip stage, commit, and push. Exits 1 if a leak is found in the preview. Nothing is written to the sync repo.                                                                                                                                                                                                                                                                                                                                                       |
| `nomad push --redact-all`        | Redact all findings non-interactively (backup written first) without a TTY. Does not auto-Allow findings. After redaction re-stages and re-scans; aborts with the session-aware FATAL if any finding survives. Use this in scripts or when you are confident every finding is a real secret that should be scrubbed. See [Recovery flow: push-time interactive menu](#recovery-flow-push-time-interactive-menu).                                                                                                                                                                                                                                                                    |
| `nomad drop-session <id>`        | Surgically unstage every `shared/projects/*/<id>.jsonl` and the sibling `shared/projects/*/<id>/` subagent directory from the staged tree of `~/claude-nomad/`. Idempotent; the local `~/.claude/projects/<encoded>/<id>.jsonl` and `<id>/` tree are preserved. See [Recovery flows](#recovery-flows).                                                                                                                                                                                                                                                                                                                                                                              |
| `nomad adopt <name>`             | Back up, then move a pre-existing `~/.claude/<name>` directory into `shared/<name>`, recreate the symlink so this host keeps working, and stage the result for push. `<name>` must already be listed in `SHARED_LINKS` or in the `sharedDirs` field of `path-map.json`; adopt is a mover, not a config editor, so it never writes `path-map.json` itself.                                                                                                                                                                                                                                                                                                                           |
| `nomad adopt <name> --dry-run`   | Preview the planned backup, move, and `git add` without touching the filesystem or the git index.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `nomad redact <session-id>`      | Rewrite the secret span in the local source transcript for a session, backed up to `~/.cache/claude-nomad/backup/`. Refuses to touch a session that was modified recently (potential active session). Safe to re-run. See [`nomad redact <session-id>`](#nomad-redact-session-id).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `nomad redact --rule <id>`       | Limit redaction to findings of one gitleaks rule id only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `nomad redact --dry-run`         | Show what `nomad redact` would change without writing anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `nomad clean --backups`          | Delete old backup snapshots under `~/.cache/claude-nomad/backup/`. By default removes snapshots older than 14 days; pass `--older-than <dur>` (e.g. `7d`, `24h`) to change the age, or `--keep <N>` to keep the N newest and delete the rest (the two flags cannot be combined). Always preview with `--dry-run` first. See [Pruning old backups](#pruning-old-backups).                                                                                                                                                                                                                                                                                                            |
| `nomad update`                   | Update the `nomad` CLI binary from npm (`npm update -g claude-nomad`). Does NOT pull your sync data; run `nomad pull` separately for that. See [Upgrading the CLI](#upgrading-the-cli).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nomad doctor`                   | Read-only health check. Each line carries a status glyph (`✓` pass, `✗` fail, `⚠︎` warn); any `✗` sets `process.exitCode = 1` (`⚠︎` does not). Includes an offline-tolerant release-version staleness check, a Hook targets check that fails (`✗`, exit 1) when `settings.json` references a hook command whose script under `~/.claude/` is missing on this host, plus a set of `⚠︎`-only checks: gitleaks version drift; on a private GitHub mirror, re-enabled Actions; optional-dependency presence (`gh` and the curl-or-wget HTTP fetcher); a backups-cache size/count nudge toward `nomad clean --backups`; an ESM/CommonJS hook-scope mismatch; and a Node-engine floor check. |
| `nomad doctor --resume-cmd <id>` | Print a host-local `cd ... && claude --resume <id>` line for a session (see [Cross-OS resume](#cross-os-resume)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `nomad doctor --check-shared`    | Read-only gitleaks preflight: stages the session transcripts a `push` would publish into a temp tree and scans them, failing (`✗`, exit 1) per affected session with rotate-and-scrub guidance. Skips with a `⚠︎` when gitleaks is not on PATH. See [Recovery flow: gitleaks FATAL on a session JSONL](#recovery-flow-gitleaks-fatal-on-a-session-jsonl).                                                                                                                                                                                                                                                                                                                            |
| `nomad doctor --check-schema`    | Read-only: fetches the live Claude Code settings schema and lists any `~/.claude/settings.json` key absent from it (candidates for the hand-maintained `APP_ONLY_KEYS` list). Non-fatal and offline-tolerant: skips with a `⚠︎` when neither curl nor wget is available or the schema is unreachable.                                                                                                                                                                                                                                                                                                                                                                                |
| `nomad --version`                | Print the installed CLI version as bare semver to stdout; exits 0. Used by the npm-publish smoke test and useful for ad-hoc upgrade checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The version-check emits ``⚠︎ claude-nomad: <local> -> <latest> (run `nomad update`)`` when the local
install is behind the latest upstream release, and `✓ claude-nomad: <local> (latest)` when current.
It silently skips on network failures.

The Hook targets check reads the live `~/.claude/settings.json` `hooks` block and fails (`✗`, exit

1. when a hook command points at a script under `~/.claude/` that is missing on this host (the
   freshly-configured-host symptom that motivated syncing `hooks/`). It deliberately skips any
   command it cannot resolve to a `~/.claude/` path (bare binaries like `jq`, unresolved env vars),
   so it never false-fails on a command that does not reference a local script.

Two further `⚠︎`-only drift checks run in `nomad doctor`. The gitleaks version-drift line
`⚠︎ gitleaks: <local> -> <pinned> (...)` fires when the local gitleaks major.minor differs from the
CI-pinned `GITLEAKS_PINNED_VERSION` (gitleaks rule and allowlist behavior tracks the minor line, so
a patch-only difference stays `✓`), and is silent when gitleaks is not on PATH. The mirror-Actions
line (carrying a `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false`
remediation hint) fires when origin is a private GitHub mirror that is gh-authed with Actions
re-enabled, complementing the auto-disable that runs on `nomad init` (see
[Privacy by default](#privacy-by-default)); it is silent on every prerequisite miss (non-GitHub
origin, `gh` unauthed, public repo, or Actions already off).

### Reading push and pull output

`nomad push` and `nomad pull` print a grouped tree, the same left-gutter layout you already see from
`nomad doctor`. There is a header line naming the command and host, then a few named sections
(`Sessions`, `Extras`, and so on), each with its items hanging off `├`/`└` connectors. A status
glyph leads every line: `✓` green for something that synced, `ℹ︎` dim for an informational count, `⚠︎`
yellow for a warning, and `✗` red for a failure. What this means for you: instead of one long flat
list with a line per project, related work is grouped and the noise is collapsed.

A clean `nomad push` looks like this (one `✓` row per project whose sessions were copied up, the
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
the full recovery block (which sessions, how to scrub them) still prints below the tree, exactly as
before (see
[Recovery flow: gitleaks FATAL on a session JSONL](#recovery-flow-gitleaks-fatal-on-a-session-jsonl)).
The same `Leak scan` row shows up under `nomad push --dry-run`, which runs that secret scan as a
read-only preview (nothing is written to the sync repo) and exits non-zero if the preview finds
anything.

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
synced, or a `⚠︎` warning naming the counts when something was skipped:

```text
⚠︎ summary: 3 unmapped on pull (run nomad doctor to list)
⚠︎ summary: 2 unmapped on push, 1 collisions (run nomad doctor to list)
```

`✓` lines go to stdout; `⚠︎` and `✗` lines go to stderr. An early, pre-tree fatal abort (for example
gitleaks missing when push checks for it, or a rebase conflict before anything is staged) suppresses
the tree entirely, so you do not see "summary: clean" stacked under an error. A later leak-scan
finding is different: by then the tree has already been built, so it still renders in full with a
`✗` Leak scan row and the recovery block below it (see
[Recovery flow: gitleaks FATAL on a session JSONL](#recovery-flow-gitleaks-fatal-on-a-session-jsonl)).
Projects with no entry in `path-map.json` for this host count as unmapped and fold into the
collapsed `ℹ︎ ... not in path-map` count; the hint points at `nomad doctor`, which lists them by
logical name.

`nomad pull --dry-run` keeps its own readable preview format (a unified diff of the `settings.json`
changes plus the transcripts a real pull would overwrite) rather than the grouped tree, so that
preview stays easy to scan; only a real `nomad pull` prints the tree above. `nomad diff` is
unchanged.

## Recovery flows

### Pruning old backups

Every `nomad pull` and `nomad push` keeps you safe by copying any file it is about to overwrite into
a timestamped snapshot under `~/.cache/claude-nomad/backup/<ts>/`. That is what makes an unexpected
overwrite recoverable, but the snapshots are never deleted automatically, so over many syncs the
folder slowly grows. It lives in your local cache and is never synced to the shared repo, so
cleaning it up is purely local disk housekeeping.

`nomad clean --backups` prunes those snapshots. **Always run it with `--dry-run` first** so you can
see exactly which snapshots it would delete before anything is removed:

```bash
$ nomad clean --backups --dry-run   # list what would be deleted, remove nothing
$ nomad clean --backups             # delete snapshots older than 14 days (the default)
```

You choose what counts as "old" in one of two ways (you cannot use both at once):

- `--older-than <duration>` deletes snapshots older than the given age. The duration is a number
  plus a unit: `d` for days, `h` for hours, `m` for minutes (for example `7d`, `24h`, `30m`). With
  no retention flag at all, the default is `--older-than 14d`.
- `--keep <N>` keeps the `N` most recent snapshots and deletes the rest, regardless of age.

`nomad clean` only ever touches the timestamped snapshot directories directly inside the backup
folder; it never follows symlinks out of it and never removes the backup folder itself. As a gentle
reminder, `nomad doctor` shows a `⚠︎` warning when the backup folder grows past roughly 20 snapshots
or 200 MB, nudging you to run `nomad clean --backups`. That warning is informational only and never
changes the doctor exit code.

### `nomad drop-session <id>`

Surgically unstages every `shared/projects/*/<id>.jsonl` plus the sibling `shared/projects/*/<id>/`
subagent directory (whose nested transcripts are keyed by the same session id) from the staged tree
of `~/claude-nomad/`. The local `~/.claude/projects/<encoded>/<id>.jsonl` and the local `<id>/` tree
are never touched.

```bash
$ nomad drop-session <id>
```

Single positional id (the session filename minus `.jsonl`). Anything else (missing id, leading dash,
extra arg) exits 1 with a `usage:` line.

For each match in the staged tree, `cmdDropSession` (in `src/commands.drop-session.ts`) classifies
the entry as tracked-in-HEAD vs newly-staged and unstages it via
`git restore --staged --worktree --` or `git rm --cached -f --` respectively. The `<id>/` subagent
directory is expanded into its staged entries via `git ls-files -z` so every nested transcript flows
through the same per-entry classification; a session that has only a subagent directory (no flat
`<id>.jsonl`) is still droppable. Idempotent: a second run on the same id sees no matching staged
entries and exits 0.

Exit codes:

- `0` on any drop, including an idempotent re-run.
- `1` with `✗ no staged session matches <id>` on stderr when neither a
  `shared/projects/*/<id>.jsonl` nor a `shared/projects/*/<id>/` directory with staged entries
  matches.

What it does NOT do: touch the local `~/.claude/projects/<encoded>/<id>.jsonl` file or the local
`<id>/` subagent tree. The local copies are preserved for `claude --resume`, grep recovery, or
whatever the user wants. If the underlying secret is real, scrubbing or removing the local files is
REQUIRED for durability, not optional housekeeping: `remapPush` (in `src/remap.ts`) re-mirrors the
local content into the staged tree on the next push, so a drop without a local scrub re-stages the
same secret.

A successful drop prints this reminder inline, pointing at the live transcript that still needs
scrubbing (the exact path when `path-map.json` maps the project to the current host, a generic
`~/.claude/projects/<encoded>/<id>.jsonl` template otherwise). This is why a
`nomad doctor --check-shared` run still reports the session after a drop: that scan reads the live
`~/.claude/projects/` source, not the staged tree, so it keeps flagging the secret until the local
transcript is scrubbed.

### `nomad redact <session-id>`

Rewrites the secret span in the local source transcript at
`~/.claude/projects/<encoded>/<session-id>.jsonl` in place, replacing each flagged span with
`[REDACTED:<rule>]`. Before rewriting, the original transcript is backed up to
`~/.cache/claude-nomad/backup/<timestamp>/`.

```bash
$ nomad redact <session-id>
$ nomad redact <session-id> --rule github-pat   # one rule only
$ nomad redact <session-id> --dry-run           # preview without writing
```

What it does: rewrites the LOCAL source transcript (not just the staged copy). This is the durable
fix for a gitleaks finding: `nomad drop-session` only removes the staged copy, but `remapPush`
re-copies from local on the next push, so the secret resurfaces. Redacting the local source means
future pushes carry clean content.

What it does NOT do: rotate credentials. Always rotate the secret at its provider first.

Safety checks:

- A session whose transcript was modified within the last 5 minutes is treated as potentially active
  (Claude Code may still be writing to it). `nomad redact` refuses to touch it and suggests
  `nomad drop-session` or waiting for the session to end.
- Before every rewrite, a backup is written to `~/.cache/claude-nomad/backup/<timestamp>/`, so the
  original content is recoverable.
- `--dry-run` prints the planned redactions and writes nothing.

This command is safe to re-run: if the span was already redacted (the replacement token is already
present), the content is unchanged.

### Recovery flow: gitleaks FATAL on a session JSONL

`nomad push` runs `gitleaks protect --staged` before commit. To catch the same findings before you
push (and without mutating anything), two read-only options are available:
`nomad doctor --check-shared` scans the session transcripts a push would publish;
`nomad push --dry-run` runs the same scan AND also covers opted-in extras (`.planning`,
`CLAUDE.md`), which `--check-shared` does not. Both stage content into a throwaway temp copy and
never write to the sync repo. A leak-scan finding is the contrast to an early, pre-tree fatal:
because the scan runs after the tree is built, the push aborts but the grouped tree still renders in
full, with a `✗ gitleaks detected secrets in N session transcript(s)` row in its `Leak scan`
section, and then the full recovery block prints below it, naming every affected session id and the
recovery command:

```text
✗ gitleaks detected secrets in 1 session transcript(s).

Session <sid-aaaa>:
  generic-api-key (14), aws-access-token (1)
  Recover with: nomad drop-session <sid-aaaa>

After recovery, re-run nomad push.
```

Two branches from here:

1. **Real secret.** Rotate the credential at its provider first (revoke in dashboard, issue
   replacement) before touching anything else. Running `nomad drop-session <sid-aaaa>` clears the
   contaminated copy from the current staged tree, but that alone is NOT durable: `remapPush` (in
   `src/remap.ts`) does a full rm-and-copy mirror of your LOCAL transcripts into `shared/projects/`
   on every push, so the next `nomad push` re-copies the un-scrubbed local file forward and
   re-stages the same secret. The durable fix is to rotate AND scrub the local transcript. The
   easiest way: `nomad redact <sid-aaaa>` (see [`nomad redact`](#nomad-redact-session-id)), which
   rewrites the secret span in place with a backup. Alternatively, remove the local transcript at
   `~/.claude/projects/<encoded>/<sid-aaaa>.jsonl` (plus the sibling `<sid-aaaa>/` subagent
   directory, if present). Do not leave the local file un-scrubbed and expect the staged-tree drop
   to hold.

2. **False positive.** Add an allowlist regex to `.gitleaks.toml` at the repo root that matches the
   noise pattern but not real-secret formats, commit it, then re-run `nomad push`. The new allowlist
   propagates to other hosts when they run `nomad update` (CLI upgrade) or when you push the updated
   file to your data repo.

`nomad drop-session` only acts on the staged tree of `~/claude-nomad/`. Active Claude Code sessions
writing to the local file are not disturbed.

### Recovery flow: push-time interactive menu

When `nomad push` detects a secret and the process is running on an interactive TTY, it presents a
per-finding menu instead of aborting immediately. Each finding is shown with its rule id, file, and
line number (the secret value is never printed: the scan uses `--redact`).

```text
Finding: github-pat in shared/projects/my-proj/abc123.jsonl line 42 (session: abc123)
  [R]edact  [A]llow  [D]rop session  [S]kip (default)
>
```

What the actions do:

- **Redact** rewrites the secret span in the LOCAL source transcript in place (same flow as
  `nomad redact`), backs up first, then re-copies the file to the staged tree. Refuses if the
  session was modified in the last 5 minutes (potential active session): choose Drop or Skip instead
  and wait for the session to end.
- **Allow** appends the finding's fingerprint to `.gitleaksignore` at the repo root. Use this for
  confirmed false positives. The fingerprint format (`file:rule:line`) is tied to the current line,
  so if the content moves gitleaks re-prompts rather than silently suppressing a new hit.
- **Drop session** excludes this session from the current push by unstaging it from the repo's git
  index (same as `nomad drop-session <id>`). The local `~/.claude/projects/.../` transcript is kept
  intact and any running Claude session is not stopped. Not durable: the next push re-copies from
  local unless you also redact or remove the local transcript.
- **Skip** (default on bare Enter) leaves the finding unresolved for now.

After you respond to every finding, the menu applies your choices. If any finding was Skipped, the
push aborts with the session-aware FATAL (same exit as a non-interactive push with findings). If all
findings were resolved, the staged tree is updated and re-scanned. A clean re-scan proceeds to
commit and push. If new findings appear after the first round of actions, the menu loops on the new
set.

On a non-TTY (CI, piped input, or scripted `nomad push`), the menu never appears and the push aborts
with the existing session-aware FATAL unchanged.

**Batch redact without a TTY:** `nomad push --redact-all` redacts every finding non-interactively
(backup written first) without prompting and without requiring a TTY. It does not auto-Allow. After
redaction the staged tree is re-scanned; any surviving finding aborts with the FATAL. Use this in
scripts or when every finding is a real secret that should be scrubbed. For a single session,
`nomad redact <session-id>` (see [`nomad redact`](#nomad-redact-session-id)) gives you per-session
control with `--rule` and `--dry-run` options.

### `.gitleaks.toml` allowlist policy

`gitleaks protect` runs against the staged tree on every `nomad push` and can flag
structurally-distinguishable tool-output noise as `generic-api-key`. The repo-root `.gitleaks.toml`
pre-allows four such patterns so routine pushes are not blocked:

- Sonar issue keys (`AY` prefix + 20+ url-safe chars).
- gitleaks fingerprint format (`<context>:<rule>:<line>` emitted by gitleaks's own reports).
- npm audit advisory hashes (anchored on the JSON shape `"id":"<40..64 hex>"`).
- Coverage-report line-keys (`key=<hex> <path>:<line>`).

The file extends the default gitleaks ruleset, so real high-entropy secrets like `ghp_*`,
`sk_live_*`, `xoxb-*`, and `AKIA*` still fire. The allowlist patterns are structurally
distinguishable from real-secret formats: a malformed credential cannot match an allowlist regex by
accident.

```toml
[extend]
useDefault = true

[[allowlists]]
description = "claude-nomad: structurally-distinguishable tool-output noise"
regexes = [
    '''AY[A-Za-z0-9_-]{20,}''',
    '''[\w-]+:[\w-]+:\d+''',
    # ...see .gitleaks.toml at the repo root for the full list
]
```

File location: `.gitleaks.toml` ships bundled with the CLI binary. At runtime both `probeGitleaks`
(in `src/push-checks.ts`) and `runGitleaksScan` (in `src/push-gitleaks.ts`) try
`<REPO_HOME>/.gitleaks.toml` first and fall back to the package-bundled copy when the repo-level
file is absent. So when you have no repo-level copy the allowlist tracks the installed binary, and
running `nomad update` (to get the latest CLI) is enough to receive allowlist updates. If you do
place a `<REPO_HOME>/.gitleaks.toml`, it takes precedence and `nomad update` will not change it; you
maintain that file yourself.

#### Customizing the allowlist with an overlay

What this means for you: if you only want to allow a couple of extra patterns of your own (say, an
internal tool that emits a structured token that keeps tripping the scan), you do not have to copy
the whole bundled allowlist into your sync repo and keep it in step by hand. Instead, drop a small
`<REPO_HOME>/.gitleaks.overlay.toml` containing only your extra `[[allowlists]]` tables (and
optionally `[[rules]]`). nomad layers your entries on top of the bundled allowlist at scan time, so
the shipped Sonar / gitleaks / npm-audit / coverage noise allows stay in effect, the gitleaks
default ruleset stays in effect, and your additions are appended to all of them.

Why this is better than a full `.gitleaks.toml`: a full repo-level `.gitleaks.toml` replaces the
bundled allowlist outright, so the shipped noise allows are lost and `nomad update` can no longer
refresh them (you own that file). The overlay is additive instead: it never drops the bundled base,
and because the base still ships with the CLI, `nomad update` keeps the base current while your
overlay rides on top.

How it works, briefly: on `nomad push`, when the overlay is present, nomad generates a throwaway
config that extends the bundled `.gitleaks.toml` (which itself extends the gitleaks default),
appends your overlay body, scans with that combined config, then deletes the throwaway file. The
merge is gitleaks' own `[extend]` append, so your allowlist entries add to the shipped and default
ones rather than replacing them.

Two rules to keep in mind:

- Your overlay must NOT contain its own `[extend]` block. nomad writes the `[extend]` line for you;
  if the overlay includes one, the push aborts with a clear error rather than scanning with a config
  you did not intend.
- If you keep BOTH a full `<REPO_HOME>/.gitleaks.toml` AND an overlay, the full `.gitleaks.toml`
  wins and the overlay is ignored (a full repo toml means you have taken complete manual control).
  Pick one approach: the overlay for additive tweaks, or a full `.gitleaks.toml` for total control.

Example `<REPO_HOME>/.gitleaks.overlay.toml` (note: no `[extend]` block):

```toml
[[allowlists]]
description = "my-org: internal build-token noise"
regexes = [
    '''BUILDTOK-[A-Za-z0-9]{24}''',
]
```

The overlay file is push-allowed (it is an exact-name entry in `PUSH_ALLOWED_STATIC` in
`src/config.ts`, alongside `.gitleaksignore`), so you can commit `.gitleaks.overlay.toml` to your
sync repo and it travels to your other hosts on the next `nomad pull`.

Editing: amend `.gitleaks.toml` in this repo, open a PR, and merge to `main`. Use TOML literal
strings (triple single quotes, `'''regex'''`) for new regex entries so backslashes do not need
escaping. Verify the new pattern does not match real-secret formats (`ghp_<36>`, `sk_live_*`,
`xoxb-*`, `AKIA[A-Z0-9]{16}`, etc.) before merging. The allowlist ships with the binary, so
`nomad update` on each host picks up the new file.

## Cross-OS resume

Claude Code embeds the original `cwd` in each session transcript. When you resume on a different
host where that path doesn't exist, the picker prints a `cd <orig-cwd> && claude --resume <id>` line
that fails (the source-host path isn't there).

Run this instead:

```bash
$ eval "$(nomad doctor --resume-cmd <session-id>)"
```

Or pipe through bash:

```bash
$ nomad doctor --resume-cmd <session-id> | bash
```

`nomad doctor --resume-cmd <id>` reads the `.jsonl`'s recorded `cwd`, reverse-looks up the logical
project in `path-map.json`, finds your current host's abspath for that logical, and prints
`cd <local-abspath> && claude --resume <id>` to stdout. The command is read-only: it never modifies
any transcript byte.

If the session isn't mapped on this host, you'll see:

```text
✗ session <id> not mapped on this host; add the logical to path-map.json
```

Other fatal surfaces: missing `~/.claude/projects/`, session id absent from every encoded dir, no
`cwd` field anywhere in the transcript, missing `path-map.json`, recorded cwd not present in any
logical's host map. All errors go to stderr prefixed with the red `✗` fail glyph; the success line
goes to stdout as a bare shell command (no glyph) so `eval` works.

## Run tests

```bash
$ npm install
$ npx vitest run
```
