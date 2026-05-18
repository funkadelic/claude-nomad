#!/usr/bin/env bash
# claude-nomad CLI update helper.
#
# Brings the deployed clone up to date with the latest upstream code:
#   1. Refuse to run on a dirty working tree or off main.
#   2. Auto-detect remote layout (fork uses `upstream`, direct clone uses
#      `origin`) and fetch the right one.
#   3. Short-circuit if there's nothing new.
#   4. Snapshot `package-lock.json` so `npm install` only runs when deps
#      actually change.
#   5. Merge the latest upstream commits. If running on a fork (upstream
#      is distinct from origin), push the result back to origin/main.
#   6. Re-install deps only when the lockfile shifted.
#
# Invoke via `npm run update` from the repo root. Idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] FATAL: %s\n' "$*" >&2; exit 1; }

# 1. Must be on main with a clean working tree.
BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "main" ] || die "must be on main; currently on '$BRANCH'"
if [ -n "$(git status --porcelain)" ]; then
  die "working tree has uncommitted or untracked changes; stash, commit, or clean before updating"
fi

# 2. Pick the remote to pull from based on what's configured.
if git remote get-url upstream >/dev/null 2>&1; then
  REMOTE="upstream"
  log "fork layout detected (using upstream remote)"
else
  REMOTE="origin"
  log "direct-clone layout detected (using origin remote)"
fi

# 3. Fetch and check for new commits.
log "fetching $REMOTE..."
git fetch --quiet "$REMOTE"

BEHIND="$(git rev-list --count "HEAD..$REMOTE/main")"
if [ "$BEHIND" -eq 0 ]; then
  log "already up to date with $REMOTE/main"
  exit 0
fi
log "$BEHIND new commit(s) on $REMOTE/main"

# 4. Snapshot package-lock.json so we can detect whether deps changed.
LOCK_BEFORE="$(git hash-object package-lock.json 2>/dev/null || echo "")"

# 5. Merge, and push to origin when on a fork layout.
log "merging $REMOTE/main..."
git merge "$REMOTE/main" --no-edit

if [ "$REMOTE" = "upstream" ]; then
  log "pushing to origin/main..."
  git push --quiet origin main
fi

# 6. npm install only if package-lock.json changed.
LOCK_AFTER="$(git hash-object package-lock.json 2>/dev/null || echo "")"
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  log "package-lock.json changed, running npm install..."
  npm install --no-audit --no-fund --silent
else
  log "package-lock.json unchanged, skipping npm install"
fi

log "done"
