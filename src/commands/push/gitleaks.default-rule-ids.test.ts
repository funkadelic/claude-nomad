import { describe, expect, it } from 'vitest';

import { GITLEAKS_PINNED_VERSION } from '../../core/config.ts';
import {
  GITLEAKS_DEFAULT_RULE_IDS,
  GITLEAKS_DEFAULT_RULE_IDS_VERSION,
} from './gitleaks.default-rule-ids.ts';

// Bumping the pin fails here until the id list is regenerated.
describe('GITLEAKS_DEFAULT_RULE_IDS', () => {
  it('was generated for the pinned gitleaks version', () => {
    expect(GITLEAKS_DEFAULT_RULE_IDS_VERSION).toBe(GITLEAKS_PINNED_VERSION);
  });

  it('includes a known default rule', () => {
    expect(GITLEAKS_DEFAULT_RULE_IDS.has('github-pat')).toBe(true);
  });

  it('holds only lowercase ids, so a case-insensitive compare stays sound', () => {
    for (const id of GITLEAKS_DEFAULT_RULE_IDS) expect(id).toBe(id.toLowerCase());
  });
});
