---
description:
  Preview what nomad push would sync (dry-run only). A real push with secret scanning and TTY
  recovery must be run in a terminal.
disable-model-invocation: true
---

!`if command -v nomad >/dev/null 2>&1; then nomad push --dry-run $ARGUMENTS; printf '\n(To run a real push with secret scanning, run nomad push in a terminal)\n'; else echo "nomad not found - install with: npm i -g claude-nomad"; fi`
