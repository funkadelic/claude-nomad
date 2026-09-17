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
 * Refusal sentence for a non-empty `blockedSettingsKeys` result, e.g.
 * `settings.json left unchanged: it has 1 setting (hooks) that is not in
 * the repo; run 'nomad capture-settings --host' to save it, then pull
 * again.` Splices fields in rather than branching on `keys.length`.
 */
export function settingsBlockedMessage(keys: string[]): string {
  const { phrase, pronoun, verb } = describeSettings(keys);
  return (
    `settings.json left unchanged: it has ${phrase} that ${verb} not in the repo; ` +
    `run 'nomad capture-settings --host' to save ${pronoun}, then pull again.`
  );
}
