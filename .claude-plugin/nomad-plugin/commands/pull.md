---
description:
  Sync ~/.claude/ from the shared repo. Runs nomad pull. Run after switching machines or when push
  was run on another host.
disable-model-invocation: true
argument-hint: [--dry-run]
---

!`nomad pull $ARGUMENTS`
