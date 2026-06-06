import { existsSync } from 'node:fs';

import { repoHome } from './config.ts';
import { appendGitleaksIgnore, isValidFingerprint } from './commands.redact.core.ts';
import { die, fail, item, log } from './utils.ts';

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
  const repo = repoHome();
  if (!existsSync(repo)) die(`repo not cloned at ${repo}`);

  for (const fp of fingerprints) {
    if (!isValidFingerprint(fp)) {
      // Escape CR/LF so an invalid multi-line value cannot split the diagnostic
      // across lines (the value is rejected, never written).
      const shown = fp.replaceAll('\r', String.raw`\r`).replaceAll('\n', String.raw`\n`);
      fail(`invalid fingerprint: ${shown}`);
      process.exit(1);
    }
  }
  for (const fp of fingerprints) {
    appendGitleaksIgnore(fp);
    item(`allowed: ${fp}`);
  }
  log(`allowed ${fingerprints.length} fingerprint(s)`);
}
