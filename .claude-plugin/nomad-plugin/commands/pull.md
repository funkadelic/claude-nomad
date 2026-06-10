---
description:
  Sync ~/.claude/ from the shared repo. Runs nomad pull. Run after switching machines or when push
  was run on another host.
disable-model-invocation: true
argument-hint: [--dry-run]
---

!`if command -v nomad >/dev/null 2>&1; then nomad pull $ARGUMENTS; else echo "nomad not found - install with: npm i -g claude-nomad"; fi`
