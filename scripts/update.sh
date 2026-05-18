#!/usr/bin/env bash
# claude-nomad CLI update helper.
#
# Brings the deployed clone up to date with the latest upstream code:
#   1. Refuse to run on a dirty working tree or off main.
#   2. Detect remote layout: fork has `origin` (mirror) + `upstream`
#      (public); direct clone has only `origin`.
#   3. Fetch all relevant remotes.
#   4. Snapshot `package-lock.json` so `npm install` only runs when deps
#      actually change.
#   5. Fast-forward to origin/main if origin is ahead. On a fork this
#      also absorbs any externally-applied "Sync fork" merges so we
#      don't create a duplicate merge commit in step 6.
#   6. On a fork, if upstream/main is still ahead after the fast-forward,
#      merge it and push the result to origin/main.
#   7. Short-circuit cleanly if nothing changed.
#   8. Re-install deps only when the lockfile shifted.
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

# 2. Detect layout.
if git remote get-url upstream >/dev/null 2>&1; then
  HAS_UPSTREAM=1
  log "fork layout detected (origin + upstream)"
else
  HAS_UPSTREAM=0
  log "direct-clone layout detected (origin only)"
fi

# 3. Fetch all relevant remotes.
log "fetching origin..."
git fetch --quiet origin
if [ "$HAS_UPSTREAM" -eq 1 ]; then
  log "fetching upstream..."
  git fetch --quiet upstream
fi

# 4. Snapshot package-lock.json so we can detect whether deps changed.
LOCK_BEFORE="$(git hash-object package-lock.json 2>/dev/null || echo "")"

# 5. Absorb anything already on origin/main (e.g. a "Sync fork" merge applied
#    via the GitHub web UI). Must be a fast-forward; bail loudly otherwise
#    so the user can untangle a divergent main manually.
ORIGIN_AHEAD="$(git rev-list --count "HEAD..origin/main")"
if [ "$ORIGIN_AHEAD" -gt 0 ]; then
  log "fast-forwarding to origin/main ($ORIGIN_AHEAD commit(s))..."
  git merge --ff-only origin/main \
    || die "main has diverged from origin/main; resolve manually before re-running"
fi

# 6. On a fork, merge any upstream commits not yet in origin and push back.
NEED_PUSH=0
if [ "$HAS_UPSTREAM" -eq 1 ]; then
  UPSTREAM_AHEAD="$(git rev-list --count "HEAD..upstream/main")"
  if [ "$UPSTREAM_AHEAD" -gt 0 ]; then
    log "merging upstream/main ($UPSTREAM_AHEAD commit(s))..."
    git merge upstream/main --no-edit
    NEED_PUSH=1
  fi
fi

# 7. Bail early if nothing actually changed.
if [ "$ORIGIN_AHEAD" -eq 0 ] && [ "$NEED_PUSH" -eq 0 ]; then
  log "already up to date"
  exit 0
fi

if [ "$NEED_PUSH" -eq 1 ]; then
  log "pushing to origin/main..."
  git push --quiet origin main
fi

# 8. npm install only if package-lock.json changed.
LOCK_AFTER="$(git hash-object package-lock.json 2>/dev/null || echo "")"
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  log "package-lock.json changed, running npm install..."
  npm install --no-audit --no-fund --silent
else
  log "package-lock.json unchanged, skipping npm install"
fi

log "done"
