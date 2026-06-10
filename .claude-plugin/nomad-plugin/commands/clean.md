---
description:
  Prune host-local backup snapshots. Defaults to removing dirs older than 14 days; pass --keep <N>
  to retain the N newest instead, or --dry-run to preview.
disable-model-invocation: true
argument-hint: [--keep <N> | --older-than <dur>] [--dry-run]
---

!`nomad clean --backups $ARGUMENTS`
