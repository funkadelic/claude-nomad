# Security policy

## Supported versions

Only the latest published release of `claude-nomad` on npm receives security fixes. Older versions
are not backported; upgrade with `npm i -g claude-nomad` (or `nomad update`) to stay current.

This is a single-maintainer project, so response to reports is best-effort with no service-level
agreement on triage or fix timelines.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's "Report a vulnerability" form. The link
below always targets the public upstream repository, even if you are reading this file inside your
own private mirror, so a report reaches the maintainer rather than your clone:

<https://github.com/funkadelic/claude-nomad/security/advisories/new>

That opens a private advisory thread visible only to you and the maintainer, and it can escalate to
a published GHSA/CVE if warranted. Please do not open a public issue for a suspected vulnerability.

## Threat model and accepted risks

`claude-nomad` is a single-user tool: the private Git repo it syncs through is assumed to be
controlled by the same person running the CLI. Several behaviors are safe under that assumption but
become risks if the sync repo is shared with others or is ever compromised. They are documented here
as accepted trade-offs rather than defended in code.

- **The secret-scanning configuration lives in the synced repo.** Push-time and CI gitleaks runs
  read `.gitleaks.toml` (and honor `.gitleaksignore`) from the repo root, and those files are
  themselves synced. Anyone who can write to the repo can therefore weaken or disable secret
  detection for every host that pulls or pushes. This is inherent to letting users curate their own
  allowlist and "Allow" individual findings; keep write access to the repo as tightly held as the
  secrets the scan is meant to protect.

- **`nomad update` runs `npm install` in the local checkout.** Updating executes the dependency
  tree's lifecycle scripts, so a compromised upstream repo (or a malicious dependency) can run code
  on the host at update time. This is the same trust you extend to any tool installed and updated
  from source; only run `nomad update` against a repo you trust.

- **The sync repo is a trust boundary for pulling hosts.** Content pulled from the repo (session
  transcripts, settings overrides, symlinked shared directories) is applied to `~/.claude/` on every
  host. Path-map keys and host paths are validated against traversal before any filesystem write,
  but the broader principle holds: a host trusts whatever the repo contains.

Under the intended single-user model none of these is exploitable by a remote party; they matter
only for multi-user repos or a repo compromise, which are out of scope for the default deployment.

## Related reading

This policy is a thin entry point; the security posture itself is documented in the README rather
than restated here:

- [Privacy by default](README.md#privacy-by-default): the two-layer CI defense (workflows skip on
  private repos, Actions auto-disabled on a private mirror) and the warning about flipping a mirror
  public.
- [What does NOT sync (deliberate trade-offs)](README.md#what-does-not-sync-deliberate-trade-offs):
  what stays host-local, including OAuth tokens and ephemeral state.

Secrets are scanned by gitleaks locally on push, and in CI on pull requests via
[`.github/workflows/gitleaks.yml`](.github/workflows/gitleaks.yml). The repo-root `.gitleaks.toml`
allowlist and its rationale are described under
[`.gitleaks.toml` allowlist policy](README.md#gitleakstoml-allowlist-policy).
