# claude-nomad

A thin wrapper around the "private Git repo" approach to syncing Claude Code config, adding two features the existing community tools don't handle:

1. **Path remapping** so session history follows you across machines even when the same repo lives at `/Users/norm/code/foo` on one host and `/home/norm/foo` on another.
2. **Per-host overrides** for `settings.json` via deep merge, so machine-specific keys (MCP server URLs, hooks, model preferences) don't fight you.

## Repo layout

```
~/claude-nomad/
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
└── src/                      # the wrapper itself
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
- `tsx` (installed automatically via `npx tsx` on first run, or `npm install -g tsx` for a global install)
- Git
- A private GitHub repo (or any Git remote you control)

## Setup

```bash
# Once, on each machine:
git clone git@github.com:you/claude-nomad.git ~/claude-nomad
cd ~/claude-nomad
./install.sh                   # verifies Node >= 22.6, installs tsx, sets up
npx tsx src/nomad.ts doctor    # see current state
npx tsx src/nomad.ts pull      # apply links + settings + sessions
```

`install.sh` will check your Node version, install `tsx` globally if it's missing, run `npm install` for project deps, and print the alias line to add to your shell rc. It's idempotent, so re-running is safe.

Add to `~/.zshrc` or `~/.bashrc` (the installer prints this exact line):

```bash
alias nomad='tsx ~/claude-nomad/src/nomad.ts'
# optional: pull on shell start
nomad pull -q 2>/dev/null &
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
