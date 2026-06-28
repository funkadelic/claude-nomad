import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasExistingClaudeConfig, resolveSnapshotChoice } from './init.prompt.ts';

/**
 * `hasExistingClaudeConfig` detects whether `~/.claude/` holds config worth
 * seeding from, and `resolveSnapshotChoice` turns the `--snapshot` flag plus
 * that detection plus a confirm seam into the effective snapshot decision.
 */
describe('init snapshot prompt helpers', () => {
  let claude: string;

  beforeEach(() => {
    claude = mkdtempSync(join(tmpdir(), 'nomad-claude-'));
  });

  afterEach(() => {
    rmSync(claude, { recursive: true, force: true });
  });

  describe('hasExistingClaudeConfig', () => {
    it('is true when settings.json exists', () => {
      writeFileSync(join(claude, 'settings.json'), '{}');
      expect(hasExistingClaudeConfig(claude)).toBe(true);
    });

    it('is true when a SHARED_LINKS file (CLAUDE.md) exists', () => {
      writeFileSync(join(claude, 'CLAUDE.md'), '# notes\n');
      expect(hasExistingClaudeConfig(claude)).toBe(true);
    });

    it('is true when a SHARED_LINKS directory (commands) is non-empty', () => {
      mkdirSync(join(claude, 'commands'));
      writeFileSync(join(claude, 'commands', 'foo.md'), 'x');
      expect(hasExistingClaudeConfig(claude)).toBe(true);
    });

    it('is false for a bare ~/.claude with nothing in it', () => {
      expect(hasExistingClaudeConfig(claude)).toBe(false);
    });

    it('is false when the only SHARED_LINKS directory is empty', () => {
      mkdirSync(join(claude, 'commands'));
      expect(hasExistingClaudeConfig(claude)).toBe(false);
    });
  });

  describe('resolveSnapshotChoice', () => {
    /** A confirm seam recording whether it was called, returning a fixed answer. */
    function spyConfirm(answer: boolean): {
      fn: (claudeHome: string) => Promise<boolean>;
      called: () => boolean;
    } {
      let invoked = false;
      return {
        fn: () => {
          invoked = true;
          return Promise.resolve(answer);
        },
        called: () => invoked,
      };
    }

    it('returns true and never prompts when --snapshot is passed', async () => {
      const confirm = spyConfirm(false);
      expect(await resolveSnapshotChoice(true, claude, confirm.fn)).toBe(true);
      expect(confirm.called()).toBe(false);
    });

    it('returns false and never prompts when no existing config is present', async () => {
      const confirm = spyConfirm(true);
      expect(await resolveSnapshotChoice(false, claude, confirm.fn)).toBe(false);
      expect(confirm.called()).toBe(false);
    });

    it('defers to the confirm seam when existing config is present (accept)', async () => {
      writeFileSync(join(claude, 'settings.json'), '{}');
      const confirm = spyConfirm(true);
      expect(await resolveSnapshotChoice(false, claude, confirm.fn)).toBe(true);
      expect(confirm.called()).toBe(true);
    });

    it('defers to the confirm seam when existing config is present (decline)', async () => {
      writeFileSync(join(claude, 'settings.json'), '{}');
      const confirm = spyConfirm(false);
      expect(await resolveSnapshotChoice(false, claude, confirm.fn)).toBe(false);
      expect(confirm.called()).toBe(true);
    });
  });
});
