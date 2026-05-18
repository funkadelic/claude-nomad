#!/usr/bin/env bash
# claude-nomad install helper.
#
# Verifies Node >= 22.6, installs tsx globally if missing, prints the alias
# snippet to add to your shell rc. Run from the repo root after cloning:
#
#   ./install.sh
#
# Idempotent: safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=6

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] FATAL: %s\n' "$*" >&2; exit 1; }

# Detect shell rc up front so gitleaks PATH hint and the closing alias snippet
# can both reference it.
case "${SHELL:-}" in
  */zsh)  RC_FILE="$HOME/.zshrc" ;;
  */bash) RC_FILE="$HOME/.bashrc" ;;
  *)      RC_FILE="your shell rc" ;;
esac

# 1. Node present?
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 22.6+ from https://nodejs.org (or via nvm/fnm/asdf), then re-run."

# 2. Node version >= 22.6?
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] \
   || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node $NODE_VERSION is too old. Need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (24 LTS recommended)."
fi
log "Node $NODE_VERSION OK"

# 3. tsx available?
if command -v tsx >/dev/null 2>&1; then
  log "tsx already on PATH ($(tsx --version 2>/dev/null || echo unknown))"
else
  log "tsx not found, installing globally via npm..."
  npm install -g tsx
  command -v tsx >/dev/null 2>&1 || die "tsx install failed. Try 'npm install -g tsx' manually."
  log "tsx installed"
fi

# 4. gitleaks present? Optional for `nomad doctor`, required for `nomad push`.
# Not auto-installed: gitleaks is a security tool and users may want a specific
# version, package-manager-managed install, or pre-vetted binary. The doctor's
# gitleaks-presence diagnostic emits the same hint at runtime.
if command -v gitleaks >/dev/null 2>&1; then
  log "gitleaks $(gitleaks version 2>/dev/null | head -1 || echo unknown) OK"
else
  log "gitleaks not on PATH (optional for nomad doctor, required for nomad push)"
  case "$(uname -s)" in
    Darwin)
      log "  Install:  brew install gitleaks"
      ;;
    Linux)
      # Map uname -m (x86_64 / aarch64 / armv7l ...) to gitleaks release asset
      # suffixes (x64 / arm64 / armv7). Fall back to a generic hint if the
      # arch is unfamiliar so we never name the wrong tarball.
      case "$(uname -m)" in
        x86_64|amd64) GL_ARCH="x64" ;;
        aarch64|arm64) GL_ARCH="arm64" ;;
        armv7l) GL_ARCH="armv7" ;;
        *) GL_ARCH="" ;;
      esac
      if [ -n "$GL_ARCH" ]; then
        log "  1. Download the linux_${GL_ARCH} tarball: https://github.com/gitleaks/gitleaks/releases"
      else
        log "  1. Download the linux artifact matching $(uname -m): https://github.com/gitleaks/gitleaks/releases"
      fi
      log "  2. Install (replace TARBALL with the path to your download):"
      log "       mkdir -p ~/.local/bin"
      log "       tar -xzf TARBALL -C ~/.local/bin gitleaks"
      log "       chmod +x ~/.local/bin/gitleaks"
      log "       gitleaks version   # verify"
      case ":${PATH:-}:" in
        *:"$HOME/.local/bin":*) ;;
        *)
          log "  3. ~/.local/bin is not on PATH; add to $RC_FILE:"
          log "       export PATH=\"\$HOME/.local/bin:\$PATH\""
          ;;
      esac
      ;;
    *)
      log "  Install:  https://github.com/gitleaks/gitleaks/releases"
      ;;
  esac
fi

# 5. Project deps installed?
if [ ! -d "$REPO_DIR/node_modules" ]; then
  log "Installing project dev dependencies..."
  (cd "$REPO_DIR" && npm install)
fi

# 6. Print the alias snippet (RC_FILE was detected at the top).
cat <<EOF

[install] Done. Add this to $RC_FILE:

  alias nomad='tsx $REPO_DIR/src/nomad.ts'

Then in a new shell:

  nomad doctor     # see current state
  nomad pull       # apply links + settings + sessions

EOF
