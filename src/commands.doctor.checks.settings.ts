import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  blue,
  dim,
  failGlyph,
  green,
  infoGlyph,
  okGlyph,
  red,
  warnGlyph,
  yellow,
} from './color.ts';
import { HOST, KNOWN_SETTINGS_KEYS, REPO_HOME, CLAUDE_HOME } from './config.ts';
import { addItem, readJsonSafe, type DoctorSection } from './commands.doctor.format.ts';

/**
 * Settings reporters for `cmdDoctor`: the shared base, the local
 * `settings.json` schema check, and the host-override diagnostic. Each helper
 * appends items to its target `DoctorSection` and signals failure by setting
 * `process.exitCode = 1`. Read-only: FAIL lines stay on stdout (a piped
 * `nomad doctor 2>/dev/null` keeps them).
 */

/** Loads shared/settings.base.json; on missing or malformed, records a FAIL item in the supplied section. Returns the parsed object or null. */
export function loadBaseSettings(section: DoctorSection): Record<string, unknown> | null {
  const basePath = join(REPO_HOME, 'shared', 'settings.base.json');
  if (!existsSync(basePath)) {
    addItem(section, `${red(failGlyph)} shared/settings.base.json missing at ${blue(basePath)}`);
    process.exitCode = 1;
    return null;
  }
  return readJsonSafe<Record<string, unknown>>(basePath, basePath, section);
}

/** Loads ~/.claude/settings.json when present and emits the schema status (okGlyph for known-keys-only, warnGlyph when unknown keys are present); returns the parsed object or null. */
export function loadAndReportSettings(section: DoctorSection): Record<string, unknown> | null {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  const settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath, section);
  if (settings === null) return null;
  const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS_KEYS.has(k));
  if (unknownKeys.length > 0) {
    addItem(
      section,
      `${yellow(warnGlyph)} settings.json has unknown keys (schema drift?): ${unknownKeys.join(', ')} (verify: nomad doctor --check-schema)`,
    );
  } else {
    addItem(section, `${green(okGlyph)} settings.json schema: known keys only`);
  }
  return settings;
}

/** Emits the host-override status: okGlyph when no host file is needed (base-only matches settings), failGlyph on drift without a host file (with candidate list), or okGlyph path when the host file parses. */
export function reportHostOverrides(
  section: DoctorSection,
  base: Record<string, unknown> | null,
  settings: Record<string, unknown> | null,
): void {
  const hostFile = join(REPO_HOME, 'hosts', `${HOST}.json`);
  let drift: string[] = [];
  if (base !== null && settings !== null) {
    const baseKeys = new Set(Object.keys(base));
    drift = Object.keys(settings).filter((k) => !baseKeys.has(k));
  }
  if (existsSync(hostFile)) {
    if (readJsonSafe<Record<string, unknown>>(hostFile, hostFile, section) !== null) {
      addItem(section, `${green(okGlyph)} host overrides: ${blue(hostFile)}`);
    }
  } else if (drift.length > 0) {
    addItem(
      section,
      `${red(failGlyph)} no hosts/${HOST}.json AND settings.json has unbased keys ${JSON.stringify(drift)}`,
    );
    const hostsDir = join(REPO_HOME, 'hosts');
    if (existsSync(hostsDir)) {
      const cands = readdirSync(hostsDir).filter((f) => f.endsWith('.json'));
      if (cands.length > 0) addItem(section, `${dim(infoGlyph)} candidates: ${cands.join(', ')}`);
    }
    process.exitCode = 1;
  } else {
    addItem(
      section,
      `${green(okGlyph)} host overrides: none (base-only is fine, no settings drift)`,
    );
  }
}
