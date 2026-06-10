#!/usr/bin/env bash
# SessionStart hook for the nomad Claude Code plugin.
# Surfaces nomad doctor WARN/FAIL lines as session context.
# Always exits 0 (D-01): a doctor FAIL must never wedge session start.
# Silent when nomad is not on PATH (D-04).
# Read-only: never writes to ~/.claude/.

# D-04: silent if nomad not installed
command -v nomad >/dev/null 2>&1 || exit 0

# Run doctor and filter to WARN/FAIL lines only.
# D-02: full doctor runs in ~2.1s, no --quiet flag needed.
# grep -F matches literal glyph bytes (U+2717 FAIL, U+26A0+U+FE0E WARN).
# || true prevents grep exit 1 (no-match on clean host) from propagating.
nomad doctor 2>/dev/null | grep -F -e '✗' -e '⚠︎' || true

# D-01: always exit 0
exit 0
