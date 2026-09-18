/**
 * Pure gate predicate and message for the settings-refusal guard, shared by
 * the wet pull path and the dry-run preview so both report the refusal in
 * the same words. No filesystem or `process` access.
 */

import {
  classifySettingsDrift,
  describeSettings,
  partitionByCaptureExclusion,
} from '../commands/capture-settings/core.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';

/**
 * Promotable ahead-drift keys a pull refuses to overwrite (credential keys never
 * named). A key `preMerged` had, or that `written` names, was removed upstream,
 * so it is not blocked.
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 * @param preMerged - The merge at the pre-pull HEAD; `{}` excludes nothing.
 * @param written - Top-level keys the last successful settings write produced
 *   on this host, or `null` for no record; unions with `preMerged`'s keys.
 * @returns The blocked keys, sorted.
 */
export function blockedSettingsKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  preMerged: Record<string, unknown>,
  written: readonly string[] | null = null,
): string[] {
  return splitAheadKeys(merged, existing, preMerged, written).blocked;
}

/**
 * Promotable live-only keys a pull deletes because the repo dropped them (the
 * complement of `blockedSettingsKeys`). Credential keys are left to
 * `credentialOverwriteCount`.
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 * @param preMerged - The merge at the pre-pull HEAD.
 * @param written - Recorded keys from the last successful write, or `null`.
 * @returns The removed keys, sorted.
 */
export function removedSettingsKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  preMerged: Record<string, unknown>,
  written: readonly string[] | null,
): string[] {
  return splitAheadKeys(merged, existing, preMerged, written).removed;
}

/**
 * Split promotable ahead-drift keys into those a pull refuses (`blocked`) and
 * those it deletes as removed upstream (`removed`).
 */
function splitAheadKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  preMerged: Record<string, unknown>,
  written: readonly string[] | null,
): { blocked: string[]; removed: string[] } {
  const { promotable } = partitionByCaptureExclusion(classifySettingsDrift(merged, existing).ahead);
  const removedUpstream = new Set([
    ...Object.keys(stripGsdHookEntries(preMerged)),
    ...(written ?? []),
  ]);
  return {
    blocked: promotable.filter((key) => !removedUpstream.has(key)),
    removed: promotable.filter((key) => removedUpstream.has(key)),
  };
}

/**
 * WARN for a non-empty `removedSettingsKeys` result, naming the keys and where
 * the pre-pull copy lives. Tense-neutral for dry run and real pull alike.
 * @param keys - The removed keys.
 * @returns The one-line message.
 */
export function settingsRemovedMessage(keys: string[]): string {
  const { phrase, pronoun } = describeSettings(keys);
  return (
    `the repo no longer carries ${phrase}; a pull removes ${pronoun} from settings.json ` +
    `(the file from before the pull is kept under ~/.cache/claude-nomad/backup/).`
  );
}

/**
 * How many live-only `CAPTURE_EXCLUDED_KEYS` the merge would drop, never naming
 * them. No `preMerged` filter: the write keeps only `merged`, so an upstream
 * removal destroys the live value just the same.
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 */
export function credentialOverwriteCount(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
): number {
  return partitionByCaptureExclusion(classifySettingsDrift(merged, existing).ahead).excluded.length;
}

/**
 * Count-only WARN for `credentialOverwriteCount`, naming no key. Tense-neutral so
 * it reads correctly in a dry run and a real pull alike.
 * @param count - A non-zero `credentialOverwriteCount` result.
 * @returns The one-line message.
 */
export function credentialOverwriteMessage(count: number): string {
  const one = count === 1;
  return (
    `your settings.json has ${count} credential ${one ? 'setting' : 'settings'} ` +
    `that the repo does not carry; a pull overwrites ${one ? 'it' : 'them'}, so keep ` +
    `per-host credential settings in ~/.claude/settings.local.json, which nomad never syncs.`
  );
}

/**
 * Refusal sentence for a non-empty `blockedSettingsKeys` result, naming both
 * ways out: capture the keys, or delete them locally if they are unwanted.
 * @param keys - The blocked keys.
 * @param state - `'left unchanged'` after a pull, `'would be left unchanged'` in a preview.
 * @returns The one-line message.
 */
export function settingsBlockedMessage(
  keys: string[],
  state: 'left unchanged' | 'would be left unchanged',
): string {
  const { phrase, pronoun, verb } = describeSettings(keys);
  return (
    `settings.json ${state}: it has ${phrase} that ${verb} not in the repo; ` +
    `run 'nomad capture-settings' to save ${pronoun} (add --host for host-specific values), ` +
    `or delete ${pronoun} from ~/.claude/settings.json if you no longer want ${pronoun}, ` +
    `then pull again.`
  );
}
