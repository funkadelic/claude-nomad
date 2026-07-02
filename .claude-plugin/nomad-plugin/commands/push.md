---
description:
  Preview what nomad push would sync (dry-run only). A real push with secret scanning and TTY
  recovery must be run in a terminal.
disable-model-invocation: true
argument-hint: '[--full-scan]'
---

!`nomad push --dry-run $(for a in $ARGUMENTS; do [ "$a" = "--dry-run" ] || printf '%s ' "$a"; done)`
