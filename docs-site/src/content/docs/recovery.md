---
title: Recovery flows
description: Pruning backups, dropping sessions, redacting secrets, and managing the gitleaks allowlist.
---

## Pruning old backups

Every `nomad pull` and `nomad push` keeps you safe by copying any file it is about to overwrite
into a timestamped snapshot under `~/.cache/claude-nomad/backup/<ts>/`. That is what makes an
unexpected overwrite recoverable, but the snapshots are never deleted automatically, so over many
syncs the folder slowly grows. It lives in your local cache and is never synced to the shared
repo, so cleaning it up is purely local disk housekeeping.

`nomad clean --backups` prunes those snapshots. **Always run it with `--dry-run` first** so you
can see exactly which snapshots it would delete before anything is removed:

```bash
$ nomad clean --backups --dry-run   # list what would be deleted, remove nothing
$ nomad clean --backups             # delete snapshots older than 14 days (the default)
```

You choose what counts as "old" in one of two ways (you cannot use both at once):

- `--older-than <duration>` deletes snapshots older than the given age. The duration is a number
  plus a unit: `d` for days, `h` for hours, `m` for minutes (for example `7d`, `24h`, `30m`).
  With no retention flag at all, the default is `--older-than 14d`.
- `--keep <N>` keeps the `N` most recent snapshots and deletes the rest, regardless of age.

`nomad clean` only ever touches the timestamped snapshot directories directly inside the backup
folder; it never follows symlinks out of it and never removes the backup folder itself. As a
gentle reminder, `nomad doctor` shows a warning when the backup folder grows past roughly 20
snapshots or 200 MB, nudging you to run `nomad clean --backups`. That warning is informational
only and never changes the doctor exit code.

## nomad drop-session

Surgically unstages every `shared/projects/*/<id>.jsonl` plus the sibling
`shared/projects/*/<id>/` subagent directory (whose nested transcripts are keyed by the same
session id) from the staged tree of `~/claude-nomad/`. The local
`~/.claude/projects/<encoded>/<id>.jsonl` and the local `<id>/` tree are never touched.

```bash
$ nomad drop-session <id>
```

Single positional id (the session filename minus `.jsonl`). Anything else (missing id, leading
dash, extra arg) exits 1 with a `usage:` line.

For each match in the staged tree, `cmdDropSession` (in `src/commands.drop-session.ts`) classifies
the entry as tracked-in-HEAD vs newly-staged and unstages it via
`git restore --staged --worktree --` or `git rm --cached -f --` respectively. The `<id>/`
subagent directory is expanded into its staged entries via `git ls-files -z` so every nested
transcript flows through the same per-entry classification; a session that has only a subagent
directory (no flat `<id>.jsonl`) is still droppable. Idempotent: a second run on the same id sees
no matching staged entries and exits 0.

Exit codes:

- `0` on any drop, including an idempotent re-run.
- `1` with `✗ no staged session matches <id>` on stderr when neither a
  `shared/projects/*/<id>.jsonl` nor a `shared/projects/*/<id>/` directory with staged entries
  matches.

What it does NOT do: touch the local `~/.claude/projects/<encoded>/<id>.jsonl` file or the local
`<id>/` subagent tree. The local copies are preserved for `claude --resume`, grep recovery, or
whatever the user wants. If the underlying secret is real, scrubbing or removing the local files
is REQUIRED for durability, not optional housekeeping: `remapPush` (in `src/remap.ts`)
re-mirrors the local content into the staged tree on the next push, so a drop without a local
scrub re-stages the same secret.

A successful drop prints this reminder inline, pointing at the live transcript that still needs
scrubbing (the exact path when `path-map.json` maps the project to the current host, a generic
`~/.claude/projects/<encoded>/<id>.jsonl` template otherwise). This is why a
`nomad doctor --check-shared` run still reports the session after a drop: that scan reads the live
`~/.claude/projects/` source, not the staged tree, so it keeps flagging the secret until the local
transcript is scrubbed.

If the session was already shipped by an earlier push, `nomad drop-session` also prints a warning
that un-staging it locally does not remove the secret from commits already on the remote. Full
remediation in that case means rotating the credential and rewriting history (for example with
`git filter-repo`) then force-pushing, coordinating with anyone else who has cloned the repo. The
check is best-effort: it looks at the upstream tracking ref, so it only fires once that session is
in pushed history.

## nomad redact

Rewrites the secret span in the local source transcripts for a session in place, replacing each
flagged span with `[REDACTED:<rule>]`. This covers the whole session subtree: the main transcript
at `~/.claude/projects/<encoded>/<session-id>.jsonl` and every nested file under
`~/.claude/projects/<encoded>/<session-id>/` (subagent transcripts, tool results), so a secret that
lives only in a subagent transcript is redacted too. Before rewriting, the original files are
backed up to `~/.cache/claude-nomad/backup/<timestamp>/`.

```bash
$ nomad redact <session-id>
$ nomad redact <session-id> --rule github-pat   # one rule only
$ nomad redact <session-id> --dry-run           # preview without writing
```

What it does: rewrites the LOCAL source transcript (not just the staged copy). This is the durable
fix for a gitleaks finding: `nomad drop-session` only removes the staged copy, but `remapPush`
re-copies from local on the next push, so the secret resurfaces. Redacting the local source means
future pushes carry clean content.

What it does NOT do: rotate credentials. Always rotate the secret at its provider first. It also
does not rewrite commits already on the remote: if the session was published by an earlier push,
`nomad redact` prints a warning that rewriting the local copy does not scrub pushed history, which
still needs a history rewrite plus force-push after you rotate.

Safety checks:

- A session is treated as potentially active (Claude Code may still be writing to it) when any
  file in its subtree (main transcript or any nested subagent file) was modified within the last
  5 minutes. `nomad redact` refuses to touch it and suggests `nomad drop-session` or waiting for
  the session to end.
- Before every rewrite, a backup is written to `~/.cache/claude-nomad/backup/<timestamp>/`, so
  the original content is recoverable.
- If a finding's secret value cannot be located verbatim in the file (for example the scanner
  reported a truncated or normalized span), the file is left unchanged and a `no redaction applied`
  warning is printed instead of a silent success. Inspect it by hand; the push re-scan still blocks
  a real leak.
- `--dry-run` prints the planned redactions and writes nothing.

This command is safe to re-run: if the span was already redacted (the replacement token is already
present), the content is unchanged.

## Recovery flow: gitleaks FATAL on a session JSONL

`nomad push` runs `gitleaks protect --staged` before commit. To catch the same findings before
you push (and without mutating anything), two read-only options are available:
`nomad doctor --check-shared` scans the session transcripts a push would publish;
`nomad push --dry-run` runs the same scan AND also covers opted-in extras (`.planning`,
`CLAUDE.md`, `.claude`), which `--check-shared` does not. Both stage content into a throwaway temp
copy and
never write to the sync repo. A leak-scan finding is the contrast to an early, pre-tree fatal:
because the scan runs after the tree is built, the push aborts but the grouped tree still renders
in full, with a `✗ gitleaks detected secrets in N session transcript(s)` row in its `Leak scan`
section, and then the full recovery block prints below it, naming every affected session id and
the recovery command:

```text
✗ gitleaks detected secrets in 1 session transcript(s).

Session <sid-aaaa>:
  generic-api-key (14), aws-access-token (1)
  Recover with: nomad drop-session <sid-aaaa>

After recovery, re-run nomad push.
```

Two branches from here:

1. **Real secret.** Rotate the credential at its provider first (revoke in dashboard, issue
   replacement) before touching anything else. Running `nomad drop-session <sid-aaaa>` clears the
   contaminated copy from the current staged tree, but that alone is NOT durable: `remapPush` (in
   `src/remap.ts`) does a full rm-and-copy mirror of your LOCAL transcripts into
   `shared/projects/` on every push, so the next `nomad push` re-copies the un-scrubbed local
   file forward and re-stages the same secret. The durable fix is to rotate AND scrub the local
   transcript. The easiest way: `nomad redact <sid-aaaa>` (see above), which rewrites the secret
   span in place with a backup. Alternatively, remove the local transcript at
   `~/.claude/projects/<encoded>/<sid-aaaa>.jsonl` (plus the sibling `<sid-aaaa>/` subagent
   directory, if present). Do not leave the local file un-scrubbed and expect the staged-tree drop
   to hold.

2. **False positive.** Add an allowlist regex to `.gitleaks.toml` at the repo root that matches
   the noise pattern but not real-secret formats, commit it, then re-run `nomad push`. The new
   allowlist propagates to other hosts when they run `nomad update` (CLI upgrade) or when you push
   the updated file to your data repo.

`nomad drop-session` only acts on the staged tree of `~/claude-nomad/`. Active Claude Code
sessions writing to the local file are not disturbed.

## Recovery flow: push-time interactive menu

When `nomad push` detects a secret and the process is running on an interactive TTY, it presents a
per-finding menu instead of aborting immediately. Each finding is shown with its rule id, file, and
line number (the secret value is never printed: the scan uses `--redact`).

```text
Finding: github-pat in shared/projects/my-proj/abc123.jsonl line 42 (session: abc123)
  [R]edact  [A]llow  [D]rop session  [S]kip (default)
>
```

What the actions do:

- **Redact** rewrites the secret span in the LOCAL source transcript in place (same flow as
  `nomad redact`), backs up first, then re-copies the file to the staged tree. Refuses if the
  session was modified in the last 5 minutes (potential active session): choose Drop or Skip
  instead and wait for the session to end.
- **Allow** appends the finding's fingerprint to `.gitleaksignore` at the repo root. Use this for
  confirmed false positives. The fingerprint format (`file:rule:line`) is tied to the current
  line, so if the content moves gitleaks re-prompts rather than silently suppressing a new hit.
- **Drop session** excludes this session from the current push by unstaging it from the repo's git
  index (same as `nomad drop-session <id>`). The local `~/.claude/projects/.../` transcript is
  kept intact and any running Claude session is not stopped. Not durable: the next push re-copies
  from local unless you also redact or remove the local transcript.
- **Skip** (default on bare Enter) leaves the finding unresolved for now.

After you respond to every finding, the menu applies your choices. If any finding was Skipped, the
push aborts with the session-aware FATAL (same exit as a non-interactive push with findings). If
all findings were resolved, the staged tree is updated and re-scanned. A clean re-scan proceeds to
commit and push. If new findings appear after the first round of actions, the menu loops on the
new set.

On a non-TTY (CI, piped input, or scripted `nomad push`), the menu never appears and the push
aborts with the existing session-aware FATAL unchanged.

**Batch redact without a TTY:** `nomad push --redact-all` redacts every finding
non-interactively (backup written first) without prompting and without requiring a TTY. It does
not auto-Allow. After redaction the staged tree is re-scanned; any surviving finding aborts with
the FATAL. Use this in scripts or when every finding is a real secret that should be scrubbed. For
a single session, `nomad redact <session-id>` gives you per-session control with `--rule` and
`--dry-run` options.

**Non-interactive allowlist:** three paths let you record false positives and proceed without the
interactive menu, all without requiring a TTY:

- `nomad push --allow <rule>` appends the fingerprints of every finding whose gitleaks rule id
  matches `<rule>` to `<REPO_HOME>/.gitleaksignore`, re-stages, and re-scans. Proceeds only when
  no finding survives the re-scan. Use this when you know a specific rule is producing noise
  (for example `generic-api-key`) but want to keep other rules active. If no finding matches the
  rule, a notice is logged and the re-scan still runs.
- `nomad push --allow-all` appends the fingerprints of ALL current findings to
  `.gitleaksignore`, re-stages, and re-scans. Proceeds only when the re-scan is clean. Use this
  to clear a batch of known false positives in one shot.
- `nomad allow <fingerprint>...` records specific fingerprints in `.gitleaksignore` ahead of a
  push, without triggering a push cycle. The fingerprint is the `file:rule:line` string shown in
  the scan output.

All three write to the same `.gitleaksignore` file described in the
[.gitleaks.toml allowlist policy](#gitleakstoml-allowlist-policy) section. The allowlist never
skips the re-scan: the decision to proceed or abort is always the re-scan result. If the re-scan
still reports a leak, the push aborts AND the entries the `--allow*` run just wrote are rolled
back, so an aborted push leaves no allowlist lines behind. `--redact-all`, `--allow-all`, and
`--allow <rule>` are mutually exclusive with each other, and none of them can be combined with
`--dry-run` (a dry-run resolves nothing). See [Commands](/claude-nomad/commands/) for the full flag reference.

## .gitleaks.toml allowlist policy

`gitleaks protect` runs against the staged tree on every `nomad push` and can flag
structurally-distinguishable tool-output noise as `generic-api-key`. The repo-root
`.gitleaks.toml` pre-allows several such patterns so routine pushes are not blocked. Every
allowlist block is path-scoped to synced session transcripts
(`shared/projects/<project>/.../*.jsonl`) with `condition = "AND"`, so a pattern can only suppress
a finding inside a transcript, never a bare token in a source file or anywhere else in the repo:

- Sonar issue keys (`AY` prefix + 20+ url-safe chars).
- gitleaks fingerprint format (`<path>.<ext>:<rule>:<line>` emitted by gitleaks's own reports).
- npm audit advisory hashes (anchored on the JSON shape `"id":"<40..64 hex>"`).
- Coverage-report line-keys (`key=<hex> <path>:<line>`).
- The documented test-fixture GitHub PAT literal and its scrub placeholders, which accumulate in
  transcripts whenever a conversation touches the docs that quote them.
- SonarCloud issue-listing output (`key: <id>` immediately followed by `rule: <lang>:S<n>`), the
  shape produced by dumping Sonar API results during a PR review.
- SSH public-key fingerprints in git signature-verification output (`with <keytype> key
  SHA256:<43-char base64>`, as printed by `git log --show-signature`). A fingerprint is a hash of
  a public key, not a credential.

The last three are additionally anchored on their surrounding output structure (via
`regexTarget = "line"`) so they cannot allow a bare token even within a transcript. The file
extends the default gitleaks ruleset, so real high-entropy secrets like `ghp_*`, `sk_live_*`,
`xoxb-*`, and `AKIA*` still fire. The allowlist patterns are structurally distinguishable from
real-secret formats: a malformed credential cannot match an allowlist regex by accident.

```toml
[extend]
useDefault = true

[[allowlists]]
description = "claude-nomad: structurally-distinguishable tool-output noise in synced session transcripts"
regexes = [
    '''AY[A-Za-z0-9_-]{20,}''',
    '''[\w./-]+\.[A-Za-z0-9]+:[\w-]+:\d+''',
    # ...see .gitleaks.toml at the repo root for the full list
]
paths = ['''^shared/projects/[^/]+/.*\.jsonl$''']
condition = "AND"
```

File location: `.gitleaks.toml` ships bundled with the CLI binary. At runtime both `probeGitleaks`
(in `src/push-checks.ts`) and `runGitleaksScan` (in `src/push-gitleaks.ts`) try
`<REPO_HOME>/.gitleaks.toml` first and fall back to the package-bundled copy when the repo-level
file is absent. So when you have no repo-level copy the allowlist tracks the installed binary, and
running `nomad update` (to get the latest CLI) is enough to receive allowlist updates. If you do
place a `<REPO_HOME>/.gitleaks.toml`, it takes precedence and `nomad update` will not change it;
you maintain that file yourself.

### Customizing the allowlist with an overlay

What this means for you: if you only want to allow a couple of extra patterns of your own (say, an
internal tool that emits a structured token that keeps tripping the scan), you do not have to copy
the whole bundled allowlist into your sync repo and keep it in step by hand. Instead, drop a small
`<REPO_HOME>/.gitleaks.overlay.toml` containing only your extra `[[allowlists]]` tables (and
optionally `[[rules]]`). nomad layers your entries on top of the bundled allowlist at scan time,
so the shipped Sonar / gitleaks / npm-audit / coverage noise allows stay in effect, the gitleaks
default ruleset stays in effect, and your additions are appended to all of them.

Why this is better than a full `.gitleaks.toml`: a full repo-level `.gitleaks.toml` replaces the
bundled allowlist outright, so the shipped noise allows are lost and `nomad update` can no longer
refresh them (you own that file). The overlay is additive instead: it never drops the bundled
base, and because the base still ships with the CLI, `nomad update` keeps the base current while
your overlay rides on top.

How it works, briefly: on `nomad push`, when the overlay is present, nomad generates a throwaway
config that extends the bundled `.gitleaks.toml` (which itself extends the gitleaks default),
appends your overlay body, scans with that combined config, then deletes the throwaway file. The
merge is gitleaks' own `[extend]` append, so your allowlist entries add to the shipped and default
ones rather than replacing them.

Two rules to keep in mind:

- Your overlay must NOT contain its own `[extend]` block. nomad writes the `[extend]` line for
  you; if the overlay includes one, the push aborts with a clear error rather than scanning with a
  config you did not intend.
- If you keep BOTH a full `<REPO_HOME>/.gitleaks.toml` AND an overlay, the full `.gitleaks.toml`
  wins and the overlay is ignored (a full repo toml means you have taken complete manual control).
  Pick one approach: the overlay for additive tweaks, or a full `.gitleaks.toml` for total control.

Example `<REPO_HOME>/.gitleaks.overlay.toml` (note: no `[extend]` block):

```toml
[[allowlists]]
description = "my-org: internal build-token noise"
regexes = [
    '''BUILDTOK-[A-Za-z0-9]{24}''',
]
```

The overlay file is push-allowed (it is an exact-name entry in `PUSH_ALLOWED_STATIC` in
`src/config.ts`, alongside `.gitleaksignore`), so you can commit `.gitleaks.overlay.toml` to your
sync repo and it travels to your other hosts on the next `nomad pull`.

Editing: amend `.gitleaks.toml` in the public repo, open a PR, and merge to `main`. Use TOML
literal strings (triple single quotes, `'''regex'''`) for new regex entries so backslashes do not
need escaping. Verify the new pattern does not match real-secret formats (`ghp_<36>`,
`sk_live_*`, `xoxb-*`, `AKIA[A-Z0-9]{16}`, etc.) before merging. The allowlist ships with the
binary, so `nomad update` on each host picks up the new file.
