# Security policy

## Supported versions

Only the latest published release of `claude-nomad` on npm receives security fixes. Older versions are not backported; upgrade with `npm i -g claude-nomad` (or `nomad update`) to stay current.

This is a single-maintainer project, so response to reports is best-effort with no service-level agreement on triage or fix timelines.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's "Report a vulnerability" form. The link below always targets the public upstream repository, even if you are reading this file inside your own private mirror, so a report reaches the maintainer rather than your clone:

https://github.com/funkadelic/claude-nomad/security/advisories/new

That opens a private advisory thread visible only to you and the maintainer, and it can escalate to a published GHSA/CVE if warranted. Please do not open a public issue for a suspected vulnerability.

## Related reading

This policy is a thin entry point; the security posture itself is documented in the README rather than restated here:

- [Privacy by default](README.md#privacy-by-default): the two-layer CI defense (workflows skip on private repos, Actions auto-disabled on a private mirror) and the warning about flipping a mirror public.
- [What does NOT sync (deliberate trade-offs)](README.md#what-does-not-sync-deliberate-trade-offs): what stays host-local, including OAuth tokens and ephemeral state.

Every push is secret-scanned by gitleaks, both locally and in CI via [`.github/workflows/gitleaks.yml`](.github/workflows/gitleaks.yml). The repo-root `.gitleaks.toml` allowlist and its rationale are described under [`.gitleaks.toml` allowlist policy](README.md#gitleakstoml-allowlist-policy).
