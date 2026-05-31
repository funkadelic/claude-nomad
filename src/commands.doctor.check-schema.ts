import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { dim, green, infoGlyph, okGlyph, warnGlyph, yellow } from './color.ts';
import { addItem, readJsonSafe, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME, SETTINGS_SCHEMA_URL } from './config.ts';
import { fetchUrl } from './http-fetch.ts';

/**
 * Opt-in `nomad doctor --check-schema` reporter. Fetches the live Claude Code
 * settings JSON schema and lists any top-level key in this host's
 * `~/.claude/settings.json` that the published schema does not define, i.e.
 * candidates for the hand-maintained `APP_ONLY_KEYS` list. Offline-tolerant by
 * design (mirrors the release version check): curl or wget missing, a network
 * failure, or a malformed schema all degrade to a single `⚠︎` skip line. Never
 * sets `process.exitCode`; this is informational discovery, not a gate.
 */

/**
 * Fetch the live settings schema via the shared HTTP fetcher (curl or wget)
 * and return its top-level property names. The fetcher is optional (matches the
 * version check): a missing binary, non-2xx response, or malformed payload all
 * surface as `null` so the caller skips cleanly. 3s timeout per binary.
 */
function fetchSchemaKeys(): string[] | null {
  try {
    const raw = fetchUrl(SETTINGS_SCHEMA_URL);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { properties?: Record<string, unknown> };
    if (typeof parsed.properties !== 'object' || parsed.properties === null) return null;
    return Object.keys(parsed.properties);
  } catch {
    return null;
  }
}

/**
 * Append the `--check-schema` result to the supplied section: an info line when
 * there is no local settings.json, a `⚠︎` skip when the schema cannot be
 * fetched, an OK line when every key is in the schema, or a `⚠︎` line naming the
 * keys absent from it (APP_ONLY_KEYS candidates).
 */
export function reportCheckSchema(section: DoctorSection): void {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) {
    addItem(section, `${dim(infoGlyph)} no ~/.claude/settings.json to check`);
    return;
  }
  const settings = readJsonSafe<Record<string, unknown>>(settingsPath, settingsPath, section);
  if (settings === null) return;

  const liveKeys = fetchSchemaKeys();
  if (liveKeys === null) {
    addItem(
      section,
      `${yellow(warnGlyph)} schema check skipped (offline, curl or wget missing, or schema unreachable)`,
    );
    return;
  }

  const liveSet = new Set(liveKeys);
  const candidates = Object.keys(settings).filter((k) => !liveSet.has(k));
  if (candidates.length === 0) {
    addItem(section, `${green(okGlyph)} settings.json keys all present in the published schema`);
  } else {
    addItem(
      section,
      `${yellow(warnGlyph)} settings.json keys absent from published schema (APP_ONLY_KEYS candidates): ${candidates.join(', ')}`,
    );
  }
}
