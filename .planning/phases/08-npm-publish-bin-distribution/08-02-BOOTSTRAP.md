# Phase 8, D-04 Bootstrap (Option A: local publish then trusted-publisher config)

**Status:** out-of-CI, one-time, maintainer-only
**Prerequisite:** Plan 01 has shipped to main; release-please has cut v0.16.2; main is at the v0.16.2 tag.
**Goal:** First publish of `claude-nomad` to npm under session auth (no long-lived registry credentials), then attach the GitHub Actions OIDC trusted-publisher rule so v0.16.3+ ships with full Sigstore provenance via `.github/workflows/npm-publish.yml`.

## Why Option A

SPEC §Boundaries forbids long-lived registry tokens categorically (not steady-state-only), eliminating any temporary-token bootstrap path. `npm trust` (npm 11.10+) cannot pre-create trusted-publisher rules for non-existent packages in 2026 (`npm/cli#8544` remains open), so first-publish must happen before trusted-publisher config can attach. Option B (placeholder 0.0.0 publish followed by a real release via OIDC) leaves a permanent `0.0.0` ghost in `npm view claude-nomad versions`, a worse durable signal for a security-positioning CLI than v0.16.2 lacking provenance for one version only. Accepted tradeoff: v0.16.2 lacks Sigstore provenance attestation; v0.16.3 onward will have full provenance.

## Steps

### Step 1. Verify npm CLI version and authenticate (manual; 2FA prompt)

Trusted publishing requires `npm` 11.5.1 or newer. Upgrade the maintainer machine first, then sign in.

```bash
npm --version
# Expect: >= 11.5.1. If older:
npm install -g npm@latest

npm adduser
# Interactive prompt; complete the 2FA TOTP step.

npm whoami
# Expect: your npm username.
```

Expected outputs: `npm --version` prints a version at or above `11.5.1`. `npm whoami` prints the maintainer's npm username. If `npm adduser` aborts, retry; nothing persists on the registry until step 2.

### Step 2. Local publish of v0.16.2 (scriptable)

From a clean checkout of `main` at the v0.16.2 tag, sanity-check the version and tarball composition before publishing.

```bash
git checkout main && git pull

node -e "console.log(require('./package.json').version)"
# Expect: 0.16.2

npm pack --dry-run
# Expect: 56-file list including LICENSE, README.md, CHANGELOG.md,
# package.json, shared/.gitignore, .gitleaks.toml, and src/*.ts.

npm publish --access public
# No --provenance flag here; this publish uses session auth and is not
# OIDC-attested. The trusted-publisher rule attaches in step 3.
```

Expected outputs: `npm pack --dry-run` lists the whitelisted files and excludes `.planning/`, `.github/`, `tests/`, `node_modules/`. `npm publish` prints the published URL on success and exits 0. The package is now reserved at `https://www.npmjs.com/package/claude-nomad`.

Recovery: if `npm publish` fails, no registry state remains behind (npm does not leave half-published artifacts). Address the failure and retry the same command.

### Step 3. Configure trusted-publisher rules (manual; web UI)

The trusted-publisher configuration lives on the `/access` tab, NOT the general settings page. This is the most-missed step.

Navigate to `https://www.npmjs.com/package/claude-nomad/access`. Locate the "Trusted Publisher" section. Click "GitHub Actions". Fill the form with exactly these values:

| Field | Value |
|-------|-------|
| Organization or user | `funkadelic` |
| Repository | `claude-nomad` |
| Workflow filename | `npm-publish.yml` (filename only, NOT a path) |
| Environment name | (leave blank) |
| Allowed actions | check "npm publish" |

Save. The "Allowed actions" checkbox is required since the May 20, 2026 npm change; configurations created before that date defaulted to `npm publish` only.

Recovery: failed web-UI saves do not modify the package state. Reload the page and retry without touching the published tarball.

### Step 4. Verify bootstrap (scriptable)

```bash
npm view claude-nomad version
# Expect: 0.16.2

npm view claude-nomad --json | jq .dist.attestations
# Expect: null for v0.16.2 (accepted; provenance attaches from v0.16.3
# onward via the CI workflow).

npm install -g claude-nomad
nomad --version
# Expect: 0.16.2

which nomad
# Expect: a path under the npm prefix's bin/ directory (e.g.
# /usr/local/bin/nomad on a default install, or ~/.npm-global/bin/nomad
# under a user-prefix setup).
```

Expected outputs: `npm view` confirms the registry has v0.16.2. `nomad --version` prints `0.16.2` (bare semver). `which nomad` resolves to the global install's bin shim.

### Step 5. First OIDC-authenticated release (automatic)

Cut a Conventional Commits change (e.g. `fix(...)`, `feat(...)`). Release-please opens the next `chore(main): release` PR; merging that PR lets release-please-action create the GitHub Release. The release event fires `.github/workflows/npm-publish.yml`, which publishes via OIDC with full Sigstore provenance attached and runs the post-publish `nomad --version` smoke test.

Expected outputs: the new GitHub Release page links to the published tarball. `npm view claude-nomad --json | jq .dist.attestations` returns a non-null Sigstore provenance object for the new version. No manual intervention required from this point onward.

## Scripted vs Manual

| Step | Scriptable | Why not scripted (if not) |
|------|------------|---------------------------|
| 1 (adduser + 2FA) | NO | 2FA TOTP is human-in-the-loop |
| 2 (local publish) | YES | Standard shell commands |
| 3 (trusted-publisher web UI) | NO | First-time config for a new package is web-UI only; `npm trust` requires the package to already exist with an existing publisher (`npm/cli#8544` open) |
| 4 (verification) | YES | Standard shell commands |
| 5 (CI publish) | Automatic | Triggered by release event; no manual step |

## Recovery

- Step 2 failure: no registry state left behind; retry the same `npm publish` command after addressing the cause.
- Step 3 failure: retry via the web UI without touching the published package.
- Step 4 disagreement: re-inspect the package on `https://www.npmjs.com/package/claude-nomad/access`; the web UI is the source of truth.

## Irreversibility

The package name `claude-nomad` is reserved by step 2. Renaming after the fact is socially expensive (existing users, search rankings, third-party documentation referencing the name). Verify the name is the intended one before running step 2; this is the last reversible moment in the bootstrap.

## One-time vs steady-state

Steps 1 through 4 are a one-time procedure per maintainer machine. Step 5 is the recurring path: every future release cuts via release-please and publishes via the CI workflow with provenance. Once bootstrap is complete, the maintainer never runs `npm publish` locally again.
