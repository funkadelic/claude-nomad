# claude-nomad

A thin wrapper around the "private Git repo" approach to syncing Claude Code config, adding two features the existing community tools don't handle:

1. **Path remapping** so session history follows you across machines even when the same repo lives at `/Users/norm/code/foo` on one host and `/home/norm/foo` on another.
2. **Per-host overrides** for `settings.json` via deep merge, so machine-specific keys (MCP server URLs, hooks, model preferences) don't fight you.

## Table of contents

- [How it works (two-repo model)](#how-it-works-two-repo-model)
- [Repo layout (what `~/claude-nomad/` looks like on a configured host)](#repo-layout-what-claude-nomad-looks-like-on-a-configured-host)
- [What gets synced vs. not](#what-gets-synced-vs-not)
- [Path remapping](#path-remapping)
- [Per-host overrides](#per-host-overrides)
- [What does NOT sync (deliberate trade-offs)](#what-does-not-sync-deliberate-trade-offs)
- [Requirements](#requirements)
- [Setup](#setup)
- [Migrating an existing ~/.claude/](#migrating-an-existing-claude)
- [Upgrading the tool](#upgrading-the-tool)
- [Commands](#commands)
- [Cross-OS resume](#cross-os-resume)
- [Run tests](#run-tests)

## How it works (two-repo model)

claude-nomad is a **tool**, not a config store. You maintain a separate **private** repo that holds your actual config (`CLAUDE.md`, agents, skills, settings overrides, session transcripts). The tool's source and your config end up coexisting in one working tree on each host.

```
public funkadelic/claude-nomad          your private you/claude-nomad
  ├── src/         (the CLI)              ├── src/         (copy of the CLI)
  ├── install.sh                          ├── install.sh
  ├── package.json                        ├── package.json
  └── ...                                 ├── ...
                                          ├── shared/      (your config, synced)
                                          │   ├── CLAUDE.md
                                          │   ├── agents/
                                          │   ├── skills/
                                          │   ├── commands/
                                          │   ├── rules/
                                          │   ├── settings.base.json
                                          │   └── projects/
                                          ├── hosts/<hostname>.json
                                          └── path-map.json
```

You bootstrap once by mirror-pushing this public tool repo into a fresh private repo of your own (see [Setup](#setup)), then layer your config on top. Every host afterward clones your private repo to `~/claude-nomad/` and runs `nomad pull` to sync.

The CLI is hardcoded to operate on `~/claude-nomad/` (see `REPO_HOME` in `src/config.ts`). Other clones of the tool (e.g., for hacking on the source itself) are fine; `nomad pull` always reads and writes the canonical path.

## Repo layout (what `~/claude-nomad/` looks like on a configured host)

```
~/claude-nomad/
├── src/                      # the CLI (came from the public tool repo)
├── scripts/                  # tool helpers (update.sh; plus any one-shot scripts you add)
├── shared/                   # synced to every machine
│   ├── CLAUDE.md
│   ├── settings.base.json    # baseline settings
│   ├── agents/
│   ├── skills/
│   ├── commands/
│   ├── rules/
│   ├── my-statusline.cjs     # any script you want symlinked into ~/.claude/
│   ├── .gitignore            # defense-in-depth: blocks .claude.json, *.token, *.key, .env
│   └── projects/             # session transcripts under logical names
├── hosts/
│   ├── <your-mac>.json       # patches merged over settings.base.json
│   ├── <your-wsl-host>.json
│   └── <your-nuc>.json
├── path-map.json             # logical project -> per-host absolute path
└── package.json, install.sh, ... (tool metadata)
```

## What gets synced vs. not

**Synced** (symlinked into `~/.claude/` from `shared/`, see `SHARED_LINKS` in `src/config.ts`):

- `CLAUDE.md`, `agents/`, `skills/`, `commands/`, `rules/`, `my-statusline.cjs`

**Generated** (written fresh on every pull):

- `settings.json` = `settings.base.json` deep-merged with `hosts/<hostname>.json`

**Remapped** (copied with path translation):

- `projects/` session transcripts

**Never synced** (per-host ephemeral state):

- `~/.claude.json` (OAuth tokens, MCP state), `history.jsonl`, `stats-cache.json`, `todos/`, `shell-snapshots/`, `debug/`, `file-history/`, `plans/`, `session-env/`, `statsig/`, `telemetry/`, `ide/`

**Auto-rehydrated by Claude Code** (not synced as files, but reconstructed from the enable list):

- `~/.claude/plugins/cache/<plugin>/...`: plugin binaries and manifests. The enable list (`enabledPlugins` in `settings.base.json`) syncs via the regenerated `settings.json`; the plugin payloads do not. On a new host, Claude Code reads the enable list and downloads the corresponding plugin payloads on first use. You do not need to manually `claude plugins install ...` per host. Caveat: plugins that depend on host-specific state (external binaries, API keys in env, MCP server URLs) still need that side set up; put those in `hosts/<host>.json` or the plugin's own per-host config.

For the deliberate trade-offs (what does NOT sync and why), see [What does NOT sync (deliberate trade-offs)](#what-does-not-sync-deliberate-trade-offs).

## Path remapping

The hard problem: Claude Code stores sessions in `~/.claude/projects/<encoded-path>/` where the encoded path is the absolute path with `/` replaced by `-`. So the same logical project ends up in different directories on each host.

`path-map.json` defines logical names and where the repo lives on each host:

```json
{
  "projects": {
    "ha-acwd": {
      "<your-mac>": "/Users/you/code/ha-acwd",
      "<your-wsl-host>": "/home/you/code/ha-acwd",
      "<your-nuc>": "TBD"
    }
  }
}
```

The host-label keys must match whatever you set `NOMAD_HOST=` to on each host (see [Setup](#setup)). Use the literal string `"TBD"` for hosts you haven't onboarded yet; `remapPull` skips TBD entries cleanly instead of creating an orphan `~/.claude/projects/TBD/`. Replace each `"TBD"` with the real path when you bring up that host.

On `push`, sessions in `~/.claude/projects/-Users-you-code-ha-acwd/` get copied to `shared/projects/ha-acwd/`. On `pull` on another machine, they get copied to that host's encoded path. `claude --resume` then finds them (see [Known limits](#known-limits-deliberate) for the cross-OS cwd-binding gotcha).

## Per-host overrides

`settings.base.json` holds portable defaults (model, permissions, plugins). `hosts/<NOMAD_HOST>.json` holds machine-specific patches. They're deep-merged on every pull (scalars override, objects merge recursively, arrays replace). Keys that used to be force-marked per-host because they embedded absolute paths (`statusLine.command`, `hooks`) can live in base if you write the commands with `$HOME` (e.g. `"command": "node \"$HOME/.claude/my-statusline.cjs\""`); Claude Code runs them through a shell so shell expansion applies. Reserve per-host files for truly machine-specific values (env, MCP URLs, host-only model overrides).

`shared/settings.base.json`:

```json
{
  "model": "claude-sonnet-4-6",
  "permissions": { "allow": ["Bash(npm run *)", "Bash(git status)"] }
}
```

`hosts/<your-wsl-host>.json`:

```json
{
  "model": "claude-opus-4-7",
  "env": { "OLLAMA_HOST": "http://localhost:11434" }
}
```

Result on that host: opus model, the local Ollama env var, plus the shared permissions array.

**Never hand-edit `~/.claude/settings.json` on a synced host.** It's regenerated on every `nomad pull` from base + host. Edit the base or host file in the repo instead.

## What does NOT sync (deliberate trade-offs)

These are intentional design choices. Read them before adopting `claude-nomad` so you opt in with eyes open. Each item lists the user-visible behavior and the rationale. The [What gets synced vs. not](#what-gets-synced-vs-not) overview above is the quick reference; this section is the deep cut.

- **Last-write-wins on conflicts.** Git surfaces them on merge; no field-level JSON merging.
- **Manual push/pull.** No file watcher. Shell hooks recommended.
- **OAuth doesn't sync.** You'll log in once per host. This is intentional.
- **Only sessions in `path-map.json` are remapped.** Drive-by sessions on un-mapped paths are left alone, which is what you want.
- **Cross-OS `claude --resume` cwd binding.** Each `.jsonl` session embeds the cwd where it was created, and the picker prints a `cd <recorded-cwd> && claude --resume <id>` line that fails on the new host. Use `nomad doctor --resume-cmd <id>` to print a host-local equivalent (see [Cross-OS resume](#cross-os-resume)). The sidecar approach was chosen over rewriting `cwd` in the transcript so Phase 1's transcript byte-equality invariant stays intact.
- **First pull on a populated host refuses to overwrite real files.** `applySharedLinks` is intentionally non-destructive. See [Migrating an existing ~/.claude/](#migrating-an-existing-claude) for the safe backup-and-rename flow.
- **Empty directories don't survive sync.** Git doesn't track empty dirs, so if any `shared/<name>/` has no files (e.g., `shared/commands/` on a host with no commands), it won't materialize on the destination host. `nomad doctor` reports it as `missing`; behavior is benign. Drop a `.gitkeep` if you want the dir to materialize.

## Requirements

- Node.js 22.6 or newer (24 LTS recommended; `install.sh` enforces the 22.6 floor)
- `tsx` (installed automatically by `install.sh`, or `npm install -g tsx` manually)
- Git
- A **private** GitHub repo (or any Git remote you control)

## Setup

**Why not just fork?** GitHub doesn't let you flip a public fork to private, and your config (especially session transcripts) must stay private. So the bootstrap is a one-time mirror-push into a fresh private repo, not a fork.

**Keep the mirror private.** Every workflow in `.github/workflows/` is gated on `${{ !github.event.repository.private }}`. The gate keys on repo visibility, not on a specific name, so workflows skip on _any_ private repo (your mirror, every adopter's mirror) and run on _any_ public repo where they're present (the canonical upstream, contributor forks, your own public mirror if you flip it). If you flip your mirror to public, CI will start firing on every `nomad push` and will likely fail because your config commits land on `main`.

One-time, on your first host:

```bash
# 1. Create the private repo (or use the GitHub UI).
gh repo create you/claude-nomad --private

# 2. Mirror the public tool into it. This severs the fork relationship,
#    so your repo is independent of upstream.
git clone --bare git@github.com:funkadelic/claude-nomad.git /tmp/cn.git
cd /tmp/cn.git
git push --mirror git@github.com:you/claude-nomad.git
cd .. && rm -rf /tmp/cn.git

# 3. Clone your private copy to the canonical location.
git clone git@github.com:you/claude-nomad.git ~/claude-nomad
cd ~/claude-nomad
./install.sh
```

`install.sh` verifies Node >= 22.6, installs `tsx` globally if missing, runs `npm install`, and prints the shell alias to add. It's idempotent, so re-running on the same or a new host is safe.

On every additional host, only step 3 is needed (your private repo already exists).

Add to `~/.zshrc` or `~/.bashrc` (the installer prints the alias line):

```bash
export NOMAD_HOST=<your-host-label>      # any short, stable label; nomad reads this instead of os.hostname()
alias nomad='tsx ~/claude-nomad/src/nomad.ts'
```

`NOMAD_HOST` overrides `os.hostname()`, which returns noisy values like `WINDOWS-I5NT6OH` on WSL or `<name>.local` on macOS. Pick a clean label per machine (e.g., `wsl-laptop`, `macbook`, `homelab-nuc`). `nomad doctor` reports the resolved host so you can confirm.

Populate your config by adding files under `shared/`, a per-host file at `hosts/<NOMAD_HOST>.json`, and `path-map.json`. Then:

```bash
nomad doctor     # read-only state check; reports host: <NOMAD_HOST>
nomad push       # send current state to the private remote
nomad pull       # apply on another host
```

If the destination host already has populated `~/.claude/{CLAUDE.md, agents/, ...}`, the first `nomad pull` will refuse to overwrite real files. See [Migrating an existing ~/.claude/](#migrating-an-existing-claude) for the safe backup-and-rename flow.

## Migrating an existing ~/.claude/

If a host already has real files at `~/.claude/{CLAUDE.md, agents/, skills/, ...}`, the first `nomad pull` will fail with `FATAL: <path> exists and is not a symlink` because `applySharedLinks` refuses to silently clobber user content. You can either move each conflicting item aside manually (`mv ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.preNomad`) and re-run pull, or use a single-pull migration script that backs up and prepares the host in one shot:

```bash
#!/usr/bin/env bash
set -euo pipefail

CLAUDE_HOME="${HOME}/.claude"
REPO_HOME="${HOME}/claude-nomad"
ITEMS=(CLAUDE.md agents skills commands rules my-statusline.cjs)
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="${HOME}/.cache/claude-nomad/backup/${TS}/snapshot.tgz"

# 1. Tar backup (rollback: tar -xzf "$BACKUP" -C "$CLAUDE_HOME").
mkdir -p "$(dirname "$BACKUP")"
present=()
for i in "${ITEMS[@]}" settings.json; do
  [ -e "$CLAUDE_HOME/$i" ] && present+=("$i")
done
[ ${#present[@]} -gt 0 ] && tar -C "$CLAUDE_HOME" -czf "$BACKUP" "${present[@]}"
echo "Backup: $BACKUP"

# 2. Copy items into shared/. rm -rf first so re-runs don't nest dirs (cp into
#    an existing directory copies SRC *inside* DEST, producing shared/agents/agents).
mkdir -p "$REPO_HOME/shared"
for i in "${ITEMS[@]}"; do
  [ -e "$CLAUDE_HOME/$i" ] || continue
  rm -rf "$REPO_HOME/shared/$i"
  if [ "$(uname -s)" = "Darwin" ]; then
    cp -pR "$CLAUDE_HOME/$i" "$REPO_HOME/shared/$i"
  else
    cp -a "$CLAUDE_HOME/$i" "$REPO_HOME/shared/$i"
  fi
done

# 3. Confirm and remove originals.
read -r -p "Remove originals from $CLAUDE_HOME? (yes/N) " ans
[ "$ans" = "yes" ] || { echo "Aborted; originals intact."; exit 1; }
for i in "${ITEMS[@]}"; do
  [ -e "$CLAUDE_HOME/$i" ] && [ ! -L "$CLAUDE_HOME/$i" ] && rm -rf "$CLAUDE_HOME/$i"
done

# 4. Pull to materialize symlinks + regenerate settings.json.
( cd "$REPO_HOME" && npx tsx src/nomad.ts pull )

# 5. Verify.
for i in "${ITEMS[@]}"; do
  test -L "$CLAUDE_HOME/$i" && echo "ok $i" || echo "MISSING $i"
done
```

Adapt the `ITEMS` list to match your `SHARED_LINKS`. The tar backup is your rollback path if anything goes wrong after the `rm`. Run from `~/claude-nomad/` after writing the script under `scripts/`. The script is also safe to re-run: items already symlinked are skipped.

## Upgrading the tool

Your private repo is not a fork, so GitHub's "Sync fork" UI doesn't apply. The shortcut on a configured host is:

```bash
cd ~/claude-nomad
npm run update
```

`npm run update` runs `scripts/update.sh`, which:

1. Refuses to run on a dirty tree (tracked OR untracked changes) or off `main` (fail-fast, no half-merges).
2. Detects layout: fork (origin + upstream) vs direct clone (origin only); fetches the remotes that apply.
3. Fast-forwards local `main` to `origin/main` first if origin is ahead. On a fork this absorbs any externally-applied "Sync fork" merge so the next step doesn't create a duplicate merge commit.
4. On a fork, if `upstream/main` is still ahead after the fast-forward, merges it and pushes the result to `origin/main`. On a direct clone, step 3 was sufficient.
5. Bails cleanly if nothing changed.
6. Re-runs `npm install` only if `package-lock.json` actually shifted.

One-time setup if you don't have the `upstream` remote yet:

```bash
git remote add upstream git@github.com:funkadelic/claude-nomad.git
```

Or do it manually:

```bash
cd ~/claude-nomad
git fetch upstream
git merge upstream/main          # or rebase
git push origin main             # publish the merge to your fork
npm install                      # only if package-lock.json changed
```

Upstream tags releases as `vX.Y.Z` (release-please). To track a specific release instead of `main`:

```bash
git fetch upstream --tags
git merge v0.2.0
git push origin main
npm install
```

## Commands

- `nomad pull`: `git pull --rebase --autostash`, apply symlinks, regenerate `settings.json`, remap session paths
- `nomad push`: export local sessions to logical names, commit (`chore: sync from <NOMAD_HOST>`), push
- `nomad doctor`: read-only health check. Reports `host: <NOMAD_HOST>`, lists each symlink as `symlink OK` / `missing` / `NOT a symlink`, lists mapped projects for the current host
- `nomad doctor --resume-cmd <session-id>` prints a host-local `cd ... && claude --resume <id>` line for the given session (see [Cross-OS resume](#cross-os-resume))

## Cross-OS resume

Claude Code embeds the original `cwd` in each session transcript. When you resume on a different host where that path doesn't exist, the picker prints a `cd <orig-cwd> && claude --resume <id>` line that fails (the source-host path isn't there).

Run this instead:

```bash
eval "$(nomad doctor --resume-cmd <session-id>)"
```

Or pipe through bash:

```bash
nomad doctor --resume-cmd <session-id> | bash
```

`nomad doctor --resume-cmd <id>` reads the `.jsonl`'s recorded `cwd`, reverse-looks up the logical project in `path-map.json`, finds your current host's abspath for that logical, and prints `cd <local-abspath> && claude --resume <id>` to stdout. The command is read-only: it never modifies any transcript byte (Phase 1's sha256 byte-equality invariant is preserved).

If the session isn't mapped on this host, you'll see:

```text
[nomad] FATAL: session <id> not mapped on this host; add the logical to path-map.json
```

Other FATAL surfaces: missing `~/.claude/projects/`, session id absent from every encoded dir, no `cwd` field anywhere in the transcript, missing `path-map.json`, recorded cwd not present in any logical's host map. All errors go to stderr with the `[nomad]` prefix; success goes to stdout WITHOUT the prefix so `eval` works.

## Run tests

```bash
npm install
npx vitest run
```
