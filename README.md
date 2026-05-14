# claude-nomad

A thin wrapper around the "private Git repo" approach to syncing Claude Code config, adding two features the existing community tools don't handle:

1. **Path remapping** so session history follows you across machines even when the same repo lives at `/Users/norm/code/foo` on one host and `/home/norm/foo` on another.
2. **Per-host overrides** for `settings.json` via deep merge, so machine-specific keys (MCP server URLs, hooks, model preferences) don't fight you.

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
├── shared/                   # synced to every machine
│   ├── CLAUDE.md
│   ├── settings.base.json    # baseline settings
│   ├── agents/
│   ├── skills/
│   ├── commands/
│   ├── rules/
│   └── projects/             # session transcripts under logical names
├── hosts/
│   ├── norm-mbp.json         # patches merged over settings.base.json
│   ├── cyberpower.json
│   └── homelab-nuc.json
├── path-map.json             # logical project -> per-host absolute path
└── package.json, install.sh, ... (tool metadata)
```

## What gets synced vs. not

**Synced** (symlinked into `~/.claude/` from `shared/`):

- `CLAUDE.md`, `agents/`, `skills/`, `commands/`, `rules/`

**Generated** (written fresh on every pull):

- `settings.json` = `settings.base.json` deep-merged with `hosts/<hostname>.json`

**Remapped** (copied with path translation):

- `projects/` session transcripts

**Never synced** (per-host ephemeral state):

- `~/.claude.json` (OAuth tokens, MCP state), `history.jsonl`, `stats-cache.json`, `todos/`, `shell-snapshots/`, `debug/`, `file-history/`, `plans/`, `session-env/`, `statsig/`, `telemetry/`, `ide/`

## Path remapping

The hard problem: Claude Code stores sessions in `~/.claude/projects/<encoded-path>/` where the encoded path is the absolute path with `/` replaced by `-`. So the same logical project ends up in different directories on each host.

`path-map.json` defines logical names and where the repo lives on each host:

```json
{
  "projects": {
    "ha-acwd": {
      "norm-mbp": "/Users/norm/code/ha-acwd",
      "cyberpower": "/home/norm/code/ha-acwd",
      "homelab-nuc": "/home/norm/projects/ha-acwd"
    }
  }
}
```

On `push`, sessions in `~/.claude/projects/-Users-norm-code-ha-acwd/` get copied to `shared/projects/ha-acwd/`. On `pull` on another machine, they get copied to that host's encoded path. `claude --resume` then finds them.

## Per-host overrides

`settings.base.json` holds shared defaults. `hosts/<hostname>.json` holds machine-specific patches. They're deep-merged on every pull. Example:

`shared/settings.base.json`:

```json
{
  "model": "claude-sonnet-4-6",
  "permissions": { "allow": ["Bash(npm run *)", "Bash(git status)"] }
}
```

`hosts/cyberpower.json`:

```json
{
  "model": "claude-opus-4-7",
  "env": { "OLLAMA_HOST": "http://localhost:11434" }
}
```

Result on `cyberpower`: opus model, the local Ollama env var, plus the shared permissions array.

## Requirements

- Node.js 22 or newer (24 LTS recommended)
- `tsx` (installed automatically by `install.sh`, or `npm install -g tsx` manually)
- Git
- A **private** GitHub repo (or any Git remote you control)

## Setup

**Why not just fork?** GitHub doesn't let you flip a public fork to private, and your config (especially session transcripts) must stay private. So the bootstrap is a one-time mirror-push into a fresh private repo, not a fork.

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

Add to `~/.zshrc` or `~/.bashrc` (the installer prints this exact line):

```bash
alias nomad='tsx ~/claude-nomad/src/nomad.ts'
# optional: pull on shell start
nomad pull -q 2>/dev/null &
```

Populate your config by adding files under `shared/`, a per-host file at `hosts/<hostname>.json`, and `path-map.json`. Then:

```bash
nomad doctor     # read-only state check
nomad push       # send current state to the private remote
nomad pull       # apply on another host
```

## Upgrading the tool

Your private repo is not a fork, so GitHub's "Sync fork" UI doesn't apply. To pull in upstream tool updates:

```bash
cd ~/claude-nomad
git remote add upstream git@github.com:funkadelic/claude-nomad.git    # one-time
git fetch upstream
git merge upstream/main                                                # or rebase
nomad push
```

Upstream tags releases as `vX.Y.Z` (release-please). To track a specific release instead of `main`:

```bash
git fetch upstream --tags
git merge v0.2.0
```

## Commands

- `nomad pull` - `git pull`, apply symlinks, regenerate `settings.json`, remap session paths
- `nomad push` - export local sessions to logical names, commit, push
- `nomad doctor` - report state, broken symlinks, unmapped projects

## Known limits (deliberate)

- **Last-write-wins on conflicts.** Git surfaces them on merge; no field-level JSON merging.
- **Manual push/pull.** No file watcher. Shell hooks recommended.
- **OAuth doesn't sync.** You'll log in once per host. This is intentional.
- **Only sessions in `path-map.json` are remapped.** Drive-by sessions on un-mapped paths are left alone, which is what you want.

## Run tests

```bash
npm install
npx vitest run
```
