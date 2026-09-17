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
 * named). A key `preMerged` had was removed upstream, so it is not blocked.
 * @param merged - The base + host merge about to be written.
 * @param existing - The parsed live settings.json.
 * @param preMerged - The merge at the pre-pull HEAD; `{}` excludes nothing.
 * @returns The blocked keys, sorted.
 */
export function blockedSettingsKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  preMerged: Record<string, unknown>,
): string[] {
  const { ahead } = classifySettingsDrift(merged, existing);
  const removedUpstream = new Set(Object.keys(stripGsdHookEntries(preMerged)));
  return partitionByCaptureExclusion(ahead.filter((key) => !removedUpstream.has(key))).promotable;
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
