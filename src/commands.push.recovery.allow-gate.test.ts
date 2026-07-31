/**
 * Behaviour coverage for the Allow gate: a `.gitleaksignore` entry is written
 * only when every finding sharing that fingerprint was actually cleaned.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Finding } from './push-gitleaks.scan.ts';
import { findingKey, type FindingAction } from './commands.push.recovery.seams.ts';
import {
  applyDeferredAllows,
  isCleared,
  type ClearedState,
} from './commands.push.recovery.allow-gate.ts';

/** Build a session finding at a given column, sharing one fingerprint. */
function sessionFinding(col: number, file = 'shared/projects/p/sess1.jsonl'): Finding {
  return {
    RuleID: 'github-pat',
    File: file,
    StartLine: 1,
    StartColumn: col,
    EndColumn: col + 39,
    Match: 'REDACTED',
    Fingerprint: `${file}:github-pat:1`,
  };
}

/** Build a ClearedState with the given actions and optionally-populated ledgers. */
function state(
  entries: [Finding, FindingAction][],
  ledgers: Partial<Omit<ClearedState, 'actions'>> = {},
): ClearedState {
  return {
    actions: new Map(entries.map(([f, a]) => [findingKey(f), a])),
    droppedSids: ledgers.droppedSids ?? new Set(),
    redactedSids: ledgers.redactedSids ?? new Set(),
    redactedMemory: ledgers.redactedMemory ?? new Set(),
    redactedSkills: ledgers.redactedSkills ?? new Set(),
  };
}

describe('isCleared', () => {
  it('treats an allowed finding as cleared', () => {
    const f = sessionFinding(1);
    expect(isCleared(f, state([[f, 'allow']]))).toBe(true);
  });

  it('treats a successfully redacted session as cleared', () => {
    const f = sessionFinding(1);
    const s = state([[f, 'redact']], { redactedSids: new Set(['sess1']) });
    expect(isCleared(f, s)).toBe(true);
  });

  it('treats a dropped session as cleared', () => {
    const f = sessionFinding(1);
    const s = state([[f, 'drop']], { droppedSids: new Set(['sess1']) });
    expect(isCleared(f, s)).toBe(true);
  });

  it('treats a FAILED redaction as not cleared', () => {
    const f = sessionFinding(1);
    expect(isCleared(f, state([[f, 'redact']]))).toBe(false);
  });

  it('treats a finding with no recorded action as not cleared', () => {
    const f = sessionFinding(1);
    expect(isCleared(f, state([]))).toBe(false);
  });

  it('treats a successfully redacted memory file as cleared', () => {
    const f = { ...sessionFinding(1), File: 'shared/projects/proj/memory/notes.md' };
    const s = state([[f, 'redact']], { redactedMemory: new Set(['proj/notes.md']) });
    expect(isCleared(f, s)).toBe(true);
  });

  it('treats a memory file whose redaction failed as not cleared', () => {
    const f = { ...sessionFinding(1), File: 'shared/projects/proj/memory/notes.md' };
    expect(isCleared(f, state([[f, 'redact']]))).toBe(false);
  });

  it('treats a successfully redacted skill file as cleared', () => {
    const f = { ...sessionFinding(1), File: 'shared/skills/my-skill/SKILL.md' };
    const s = state([[f, 'redact']], { redactedSkills: new Set(['my-skill/SKILL.md']) });
    expect(isCleared(f, s)).toBe(true);
  });

  it('treats a skill file whose redaction failed as not cleared', () => {
    const f = { ...sessionFinding(1), File: 'shared/skills/my-skill/SKILL.md' };
    expect(isCleared(f, state([[f, 'redact']]))).toBe(false);
  });

  it('treats a non-session, non-memory, non-skill finding as not cleared', () => {
    const f = { ...sessionFinding(1), File: 'shared/other/thing.txt' };
    expect(isCleared(f, state([[f, 'redact']]))).toBe(false);
  });
});

describe('applyDeferredAllows', () => {
  /** Read the .gitleaksignore a gate run produced, or '' when none was written. */
  function ignoreAfter(findings: Finding[], s: ClearedState): string {
    const repo = mkdtempSync(join(tmpdir(), 'allow-gate-'));
    try {
      applyDeferredAllows(findings, s, repo);
      const path = join(repo, '.gitleaksignore');
      return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it('writes the fingerprint when every finding sharing it is cleared', () => {
    const a = sessionFinding(1);
    const b = sessionFinding(51);
    const written = ignoreAfter(
      [a, b],
      state([
        [a, 'allow'],
        [b, 'allow'],
      ]),
    );
    expect(written).toBe(a.Fingerprint);
  });

  it('holds the fingerprint back when a peer redaction failed', () => {
    // Both share one fingerprint, so writing it would suppress the second
    // secret, which was never cleaned. The push stays blocked instead.
    const allowed = sessionFinding(1);
    const failed = sessionFinding(51);
    expect(allowed.Fingerprint).toBe(failed.Fingerprint);
    const written = ignoreAfter(
      [allowed, failed],
      state([
        [allowed, 'allow'],
        [failed, 'redact'],
      ]),
    );
    expect(written).toBe('');
  });

  it('writes the fingerprint when the peer was redacted successfully', () => {
    const allowed = sessionFinding(1);
    const redacted = sessionFinding(51);
    const written = ignoreAfter(
      [allowed, redacted],
      state(
        [
          [allowed, 'allow'],
          [redacted, 'redact'],
        ],
        { redactedSids: new Set(['sess1']) },
      ),
    );
    expect(written).toBe(allowed.Fingerprint);
  });

  it('does not hold back an unrelated fingerprint on another line', () => {
    const allowed = sessionFinding(1);
    const elsewhere = sessionFinding(1, 'shared/projects/p/sess2.jsonl');
    const written = ignoreAfter(
      [allowed, elsewhere],
      state([
        [allowed, 'allow'],
        [elsewhere, 'redact'],
      ]),
    );
    expect(written).toBe(allowed.Fingerprint);
  });

  it('writes nothing for an allowed finding whose session was dropped', () => {
    // Drop wins: the content never reaches the push, so an ignore entry would
    // be stale.
    const allowed = sessionFinding(1);
    const written = ignoreAfter(
      [allowed],
      state([[allowed, 'allow']], { droppedSids: new Set(['sess1']) }),
    );
    expect(written).toBe('');
  });

  it('writes nothing for a finding with no recorded action', () => {
    // The `?? skip` fallback: a finding the prompt loop never answered for.
    const orphan = sessionFinding(1);
    expect(ignoreAfter([orphan], state([]))).toBe('');
  });

  it('writes the fingerprint for an allowed non-session finding', () => {
    // sessionIdFromFinding returns null for a skill path, so the drop-wins
    // guard short-circuits on the null branch.
    const skill = { ...sessionFinding(1), File: 'shared/skills/my-skill/SKILL.md' };
    expect(ignoreAfter([skill], state([[skill, 'allow']]))).toBe(skill.Fingerprint);
  });

  it('ignores findings the user did not allow', () => {
    const redacted = sessionFinding(1);
    const written = ignoreAfter(
      [redacted],
      state([[redacted, 'redact']], { redactedSids: new Set(['sess1']) }),
    );
    expect(written).toBe('');
  });
});

describe('empty fingerprints', () => {
  it('writes nothing and reports no blank id for an empty fingerprint', () => {
    const f = { ...sessionFinding(1), Fingerprint: '' };
    const repo = mkdtempSync(join(tmpdir(), 'allow-gate-'));
    const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      applyDeferredAllows([f], state([[f, 'allow']]), repo);
      expect(existsSync(join(repo, '.gitleaksignore'))).toBe(false);
      // The second half of the claim: no notice naming a blank fingerprint.
      const messages = warned.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('not allowing '))).toBe(false);
    } finally {
      warned.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
