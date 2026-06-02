import { existsSync } from 'node:fs';

import { REPO_HOME } from './config.ts';
import { appendGitleaksIgnore, isValidFingerprint } from './commands.redact.core.ts';
import { die, fail, log } from './utils.ts';

/**
 * Validate each fingerprint with `isValidFingerprint`, then append each valid
 * one to `REPO_HOME/.gitleaksignore` via `appendGitleaksIgnore` (idempotent:
 * duplicates are silently skipped). Validation is applied to every fingerprint
 * before any write; the first invalid value triggers a FATAL and nothing is
 * written for it or any subsequent entry.
 *
 * Dies early when `REPO_HOME` is not present (mirrors `cmdPush`).
 *
 * @param fingerprints One or more fingerprint strings (already extracted from
 *   argv by `parseAllowArgs`).
 */
export function cmdAllow(fingerprints: string[]): void {
  if (!existsSync(REPO_HOME)) die(`repo not cloned at ${REPO_HOME}`);

  for (const fp of fingerprints) {
    if (!isValidFingerprint(fp)) {
      fail(`invalid fingerprint: ${fp}`);
      process.exit(1);
    }
  }
  for (const fp of fingerprints) {
    appendGitleaksIgnore(fp);
    log(`allowed: ${fp}`);
  }
}
