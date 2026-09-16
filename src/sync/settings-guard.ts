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

/**
 * Ahead-drift keys minus `CAPTURE_EXCLUDED_KEYS`: what a pull would refuse to
 * overwrite. Returns `promotable` only, never `ahead`, so a credential key
 * name never reaches a caller.
 */
export function blockedSettingsKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
): string[] {
  const { ahead } = classifySettingsDrift(merged, existing);
  return partitionByCaptureExclusion(ahead).promotable;
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
