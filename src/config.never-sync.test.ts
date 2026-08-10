import { describe, expect, it } from 'vitest';

import {
  ALWAYS_NEVER_SYNC,
  blockSetFor,
  CLAUDE_EXTRA_NEVER_SYNC,
  deniedSegmentFor,
  isNeverSync,
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
  it('returns the full NEVER_SYNC set for a path outside the extras tree', () => {
    expect(blockSetFor('shared/commands/deploy.md'.split('/'))).toBe(NEVER_SYNC);
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
});

describe('isNeverSync', () => {
  it('blocks a generic NEVER_SYNC directory segment outside the extras tree', () => {
    expect(isNeverSync('shared/commands/sessions/notes.md')).toBe(true);
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
});

describe('deniedSegmentFor', () => {
  it('returns the exact segment that caused the block', () => {
    expect(deniedSegmentFor('shared/commands/sessions/notes.md')).toBe('sessions');
  });

  it('returns the FIRST matching segment when a path carries more than one', () => {
    expect(deniedSegmentFor('shared/commands/plans/todos/a.md')).toBe('plans');
  });

  it('returns the segment as spelled on disk, not the denylist entry it matched', () => {
    // The WARN this feeds names the user's own spelling back to them, so a
    // case-folded match must not be normalized on the way out.
    expect(deniedSegmentFor('shared/commands/Sessions/notes.md')).toBe('Sessions');
  });

  it('returns null for a clean path', () => {
    expect(deniedSegmentFor('shared/commands/deploy.md')).toBeNull();
  });

  it('returns null for extras content the narrow subset allows', () => {
    expect(deniedSegmentFor('shared/extras/myproj/.planning/todos/a.md')).toBeNull();
  });
});
