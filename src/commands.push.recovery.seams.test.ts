import { describe, expect, it } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import { sessionIdFromFinding } from './commands.push.recovery.seams.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal Finding fixture with optional field overrides. */
function makeFinding(
  overrides: Partial<{
    RuleID: string;
    File: string;
    StartLine: number;
    StartColumn: number;
    EndColumn: number;
    Match: string;
    Fingerprint: string;
  }> = {},
): Finding {
  return {
    RuleID: overrides.RuleID ?? 'github-pat',
    File: overrides.File ?? 'shared/projects/my-proj/abc123.jsonl',
    StartLine: overrides.StartLine ?? 1,
    StartColumn: overrides.StartColumn ?? 1,
    EndColumn: overrides.EndColumn ?? 40,
    Match: overrides.Match ?? 'ghp_FAKESECRETVALUE1234567890ABCDEF',
    Fingerprint: overrides.Fingerprint ?? 'shared/projects/my-proj/abc123.jsonl:github-pat:1',
    Description: 'GitHub PAT',
  };
}

// ---------------------------------------------------------------------------
// sessionIdFromFinding
// ---------------------------------------------------------------------------

describe('sessionIdFromFinding', () => {
  it('returns null for a memory/*.md finding (no bogus "memory" session id)', () => {
    const finding = makeFinding({ File: 'shared/projects/foo/memory/notes.md' });
    expect(sessionIdFromFinding(finding)).toBeNull();
  });

  it('returns null for a nested memory/<subdir>/x.md finding (no bogus "memory" session id)', () => {
    // Defensive: a nested path under the project-level memory/ directory is not
    // the redactable flat shape, but it must still be excluded from session-id
    // resolution so it cannot mis-resolve to sid "memory" and steer to Allow.
    const finding = makeFinding({ File: 'shared/projects/foo/memory/sub/notes.md' });
    expect(sessionIdFromFinding(finding)).toBeNull();
  });

  it('returns the session id for a flat <sid>.jsonl finding', () => {
    const finding = makeFinding({ File: 'shared/projects/foo/abc123.jsonl' });
    expect(sessionIdFromFinding(finding)).toBe('abc123');
  });

  it('returns the session id for a nested subagent <sid>/.../x.jsonl finding', () => {
    const finding = makeFinding({ File: 'shared/projects/foo/abc123/subagents/x.jsonl' });
    expect(sessionIdFromFinding(finding)).toBe('abc123');
  });

  it('returns null when the extracted id contains a path-traversal segment', () => {
    const finding = makeFinding({ File: 'shared/projects/foo/../etc/x.jsonl' });
    expect(sessionIdFromFinding(finding)).toBeNull();
  });

  it('returns the session id for a non-.jsonl subtree file (tool-results/*.txt regression)', () => {
    // Regression guard: sessionIdFromFinding must resolve a session id for
    // ANY file under a session's subtree, not just .jsonl transcripts, since
    // applyRedact already redacts tool-results/*.txt and other non-jsonl
    // subtree files. A prior fix that reused the .jsonl-anchored
    // SUBAGENT_SESSION_PATH here broke this case.
    const finding = makeFinding({ File: 'shared/projects/foo/abc123/tool-results/x.txt' });
    expect(sessionIdFromFinding(finding)).toBe('abc123');
  });
});
