import { describe, expect, it } from 'vitest';

import {
  ALWAYS_NEVER_SYNC,
  blockSetFor,
  CLAUDE_EXTRA_NEVER_SYNC,
  deniedSegmentFor,
  isNeverSync,
  matchDeniedName,
  NEVER_SYNC,
} from './config.never-sync.ts';

/**
 * Direct unit cover for the denylist predicate now that it lives in this leaf
 * and serves BOTH the push allow-list gate and the pull-side mirror gate. It
 * was previously reachable only through `enforceAllowList`, which meant every
 * assertion about it also carried the push gate's allow-list, gsd-drop, and
 * fatal-throw behavior. These test the predicate itself.
 */
describe('blockSetFor', () => {
  it('returns ALWAYS_NEVER_SYNC for an ordinary shared name (shared/<name>/...)', () => {
    // The content sits under a name the user asked to share. On win32 the
    // mirror happens to have applied the same set at copy time; on posix no
    // writer runs ahead of the gate at all, and it is narrowed there anyway.
    expect(blockSetFor('shared/commands/deploy.md'.split('/'))).toBe(ALWAYS_NEVER_SYNC);
  });

  it('returns the narrow ALWAYS_NEVER_SYNC subset inside shared/extras/', () => {
    expect(blockSetFor('shared/extras/myproj/.planning/todos/a.md'.split('/'))).toBe(
      ALWAYS_NEVER_SYNC,
    );
  });

  it('returns the broader CLAUDE_EXTRA_NEVER_SYNC set for the .claude extra', () => {
    expect(blockSetFor('shared/extras/myproj/.claude/projects/x.jsonl'.split('/'))).toBe(
      CLAUDE_EXTRA_NEVER_SYNC,
    );
  });

  it('does not downgrade to the narrow subset on a case-folded .claude spelling', () => {
    // `.Claude` is the same directory as `.claude` on a case-insensitive
    // filesystem, so it must not select the set that lacks `projects`.
    expect(blockSetFor('shared/extras/myproj/.Claude/projects/x.jsonl'.split('/'))).toBe(
      CLAUDE_EXTRA_NEVER_SYNC,
    );
  });

  it('returns ALWAYS_NEVER_SYNC for a short extras path with no dirname segment', () => {
    // segments[3] is undefined here (only shared/extras/<logical>), so
    // isClaudeExtraName('') must be false rather than throwing.
    expect(blockSetFor('shared/extras/myproj'.split('/'))).toBe(ALWAYS_NEVER_SYNC);
  });

  it('still resolves the .claude extra to CLAUDE_EXTRA_NEVER_SYNC regardless of arm ordering', () => {
    // A later reordering of blockSetFor's arms must not silently downgrade
    // the .claude extra to a set that lacks `projects`.
    expect(blockSetFor('shared/extras/myproj/.claude/settings.json'.split('/'))).toBe(
      CLAUDE_EXTRA_NEVER_SYNC,
    );
  });
});

/**
 * The shared-name branch settled by this phase: `blockSetFor` narrows to
 * `ALWAYS_NEVER_SYNC` for an ordinary `shared/<name>/` path, because the
 * content sits under a name the user asked to share. A change to
 * `UNFILTERED_SHARED_REGIONS` must fail one of these cases.
 */
describe('blockSetFor: the shared-name branch', () => {
  it('narrows for an adopted or statically-shared name', () => {
    expect(blockSetFor('shared/my-tools/notes.md'.split('/'))).toBe(ALWAYS_NEVER_SYNC);
  });

  it('narrows for shared/skills/, closing a pre-existing disagreement deliberately', () => {
    // The skills writer has applied the narrow set on both directions since
    // it was written; the gate behind it was wide until this phase. This
    // case settles that disagreement on purpose rather than as a side effect.
    expect(blockSetFor('shared/skills/mine/SKILL.md'.split('/'))).toBe(ALWAYS_NEVER_SYNC);
  });

  it('stays on NEVER_SYNC for shared/projects/, whose writer filters nothing below its top level', () => {
    expect(blockSetFor('shared/projects/foo/x.jsonl'.split('/'))).toBe(NEVER_SYNC);
  });

  it('stays on NEVER_SYNC for a bare ["shared"] path with no name segment to be scoped to', () => {
    // Required for patch coverage on the segments.length > 1 guard.
    expect(blockSetFor(['shared'])).toBe(NEVER_SYNC);
  });

  it('does not leak the narrow set outside shared/', () => {
    expect(blockSetFor('hosts/dell.json'.split('/'))).toBe(NEVER_SYNC);
    expect(blockSetFor(['CLAUDE.md'])).toBe(NEVER_SYNC);
  });

  // A case-insensitive filesystem (macOS APFS, NTFS) resolves every spelling
  // below to the SAME directory as its lowercase twin, so a raw Set.has on the
  // region segment would let the spelling alone pick the narrower denylist.
  it.each(['Projects', 'PROJECTS', 'projects.', 'projects '])(
    'keeps the wide set for the %s spelling of the projects region',
    (region) => {
      expect(blockSetFor(`shared/${region}/foo/x.jsonl`.split('/'))).toBe(NEVER_SYNC);
    },
  );

  it.each(['Extras', 'EXTRAS', 'extras.'])(
    'routes the %s spelling of the extras region through the extras arm, not the shared-name arm',
    (region) => {
      // Same set either way, so the observable difference is the `.claude`
      // sub-arm: only the extras arm can widen back to CLAUDE_EXTRA_NEVER_SYNC.
      expect(blockSetFor(`shared/${region}/myproj/.claude/projects/x.jsonl`.split('/'))).toBe(
        CLAUDE_EXTRA_NEVER_SYNC,
      );
    },
  );

  // The extras arm carries a SCAN RANGE as well as a set: `deniedSegmentFor`
  // starts at segment 4, so the `<logical>` name cannot hard-block its own
  // files. A floor name parked directly at `shared/extras/<logical>/<file>`
  // therefore sits above the scan and this gate does not catch it, in either
  // spelling. That is pre-existing for the lowercase one and normalizing the
  // region test extended it to the mis-cased one, so it is pinned here as the
  // real behavior rather than left to be rediscovered. It is not a hole in the
  // boundary: the allow-list admits nothing at that depth, and the extras copy
  // filter applies the same floor at every level (see backlog 999.91 for the
  // scan-range question itself).
  it.each(['extras', 'Extras'])(
    'does not catch a floor name parked above the extras scan range (%s spelling)',
    (region) => {
      expect(isNeverSync(`shared/${region}/myproj/settings.local.json`)).toBe(false);
    },
  );

  it.each(['extras', 'Extras'])(
    'still catches the same floor name once it is inside the extras scan range (%s spelling)',
    (region) => {
      expect(isNeverSync(`shared/${region}/myproj/.planning/settings.local.json`)).toBe(true);
    },
  );
});

describe('isNeverSync', () => {
  it('no longer blocks a generic NEVER_SYNC-only directory segment under an ordinary shared name', () => {
    // shared/commands/ is an ordinary shared name, so the mirror already
    // writes `sessions/` there unfiltered; the gate now agrees.
    expect(isNeverSync('shared/commands/sessions/notes.md')).toBe(false);
  });

  it('passes an ordinary shared path', () => {
    expect(isNeverSync('shared/commands/deploy.md')).toBe(false);
  });

  it('passes .planning content inside the extras tree, where the narrow subset applies', () => {
    // The logical and dirname segments are not scanned at all, and `todos` is
    // absent from ALWAYS_NEVER_SYNC, so legitimate planning content rides
    // through the extras gate.
    expect(isNeverSync('shared/extras/myproj/.planning/todos/a.md')).toBe(false);
  });

  it('blocks a .claude extra transcript path, where the broader boundary applies', () => {
    expect(isNeverSync('shared/extras/myproj/.claude/projects/x.jsonl')).toBe(true);
  });

  it('does not treat a logical named after a denylist token as a hit', () => {
    // `sessions` here is the LOGICAL project name (segment 2), which is never
    // scanned; blocking it would break that project's own legitimate files.
    expect(isNeverSync('shared/extras/sessions/.planning/a.md')).toBe(false);
  });

  it('blocks a credential-shaped filename the exact sets do not enumerate', () => {
    expect(isNeverSync('shared/commands/.env')).toBe(true);
  });

  it('admits the widened NEVER_SYNC-only names under an ordinary shared name', () => {
    // Stated positively: the widening itself, not just the negation above.
    expect(isNeverSync('shared/my-tools/sessions/notes.md')).toBe(false);
    expect(isNeverSync('shared/my-tools/plans/a.md')).toBe(false);
    expect(isNeverSync('shared/my-tools/tasks/x.md')).toBe(false);
  });

  it('the shape axis stays live under the new shared-name branch', () => {
    // Independent of which set is chosen: a credential-shaped directory or
    // filename is still denied.
    expect(isNeverSync('shared/my-tools/credentials/token')).toBe(true);
    expect(isNeverSync('shared/my-tools/.env')).toBe(true);
  });

  it.each([...ALWAYS_NEVER_SYNC])(
    'still blocks the credential/host-config floor name %s under every region this phase touches',
    (name) => {
      for (const prefix of [
        'shared/my-tools/',
        'shared/commands/',
        'shared/skills/mine/',
        'shared/projects/foo/',
      ]) {
        const path = `${prefix}${name}`;
        expect(isNeverSync(path)).toBe(true);
        expect(deniedSegmentFor(path)).toBe(name);
      }
    },
  );
});

describe('matchDeniedName', () => {
  // The axis this returns decides what a refusal tells the user to do, so
  // each of the four exact-name spellings and the shape fallback is pinned
  // separately: they are what tells a rename-clears-it collision apart from a
  // credential shape a rename cannot touch.
  it('reports a plain exact-name hit, quoting the entry that matched', () => {
    expect(matchDeniedName(NEVER_SYNC, 'settings.local.json')).toEqual({
      axis: 'name',
      entry: 'settings.local.json',
    });
  });

  it('reports a case-folded hit as the lowercase entry, not the caller spelling', () => {
    expect(matchDeniedName(NEVER_SYNC, 'Settings.local.json')).toEqual({
      axis: 'name',
      entry: 'settings.local.json',
    });
  });

  it('reports a trailing-dot hit as the entry underneath the dots', () => {
    expect(matchDeniedName(NEVER_SYNC, 'settings.local.json.')).toEqual({
      axis: 'name',
      entry: 'settings.local.json',
    });
  });

  it('reports a hit that needs both normalizations at once', () => {
    expect(matchDeniedName(NEVER_SYNC, 'Settings.local.json. ')).toEqual({
      axis: 'name',
      entry: 'settings.local.json',
    });
  });

  it('reports a credential filename shape as the shape axis, with no entry to quote', () => {
    expect(matchDeniedName(NEVER_SYNC, 'server.pem')).toEqual({ axis: 'shape' });
    expect(matchDeniedName(NEVER_SYNC, '.env.local')).toEqual({ axis: 'shape' });
  });

  it('returns null for a clean basename', () => {
    expect(matchDeniedName(NEVER_SYNC, 'deploy.md')).toBeNull();
  });
});

describe('deniedSegmentFor', () => {
  it('no longer flags a single widened segment under an ordinary shared name', () => {
    expect(deniedSegmentFor('shared/commands/sessions/notes.md')).toBeNull();
  });

  it('no longer flags two widened segments under an ordinary shared name', () => {
    expect(deniedSegmentFor('shared/commands/plans/todos/a.md')).toBeNull();
  });

  it('no longer flags a case-folded widened segment under an ordinary shared name', () => {
    expect(deniedSegmentFor('shared/commands/Sessions/notes.md')).toBeNull();
  });

  it('returns the segment as spelled on disk, case-folded match, for a name still on the floor', () => {
    // The WARN this feeds names the user's own spelling back to them, so a
    // case-folded match must not be normalized on the way out. Moved off the
    // widened `sessions` fixture onto a floor name that survives under the
    // new shared-name branch, so this hardening stays pinned rather than
    // silently dropping with the fixture.
    expect(deniedSegmentFor('shared/commands/Settings.local.json')).toBe('Settings.local.json');
  });

  it('returns null for a clean path', () => {
    expect(deniedSegmentFor('shared/commands/deploy.md')).toBeNull();
  });

  it('returns null for extras content the narrow subset allows', () => {
    expect(deniedSegmentFor('shared/extras/myproj/.planning/todos/a.md')).toBeNull();
  });
});
