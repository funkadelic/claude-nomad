---
description:
  Run nomad health checks - symlinks, settings drift, path-map, gitleaks probe, remote reachability.
disable-model-invocation: true
---

!`if command -v nomad >/dev/null 2>&1; then nomad doctor $ARGUMENTS; else echo "nomad not found - install with: npm i -g claude-nomad"; fi`
