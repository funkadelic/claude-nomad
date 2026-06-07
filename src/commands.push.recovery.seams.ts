/**
 * Pure, side-effect-free seams for the push-time recovery menu: key
 * derivation, session-id extraction, prompt-answer parsing, and finding-context
 * masking. Extracted from `commands.push.recovery.actions.ts` so both modules
 * stay under the 220-line advisory cap.
 */

import type { Finding } from './push-gitleaks.scan.ts';
import { SESSION_PATH } from './push-gitleaks.ts';

// ---------------------------------------------------------------------------
// Secret masking constants
// ---------------------------------------------------------------------------

/** Number of leading characters to keep before the mask in maskSecret. */
const MASK_LEAD = 4;

/** Fixed-length mask string appended after the kept lead. Non-length-preserving so no length info leaks. */
const MASK_BODY = '************';

/** Context window: maximum chars of source prefix or suffix shown on each side of the masked span. */
const CONTEXT_WINDOW = 40;

/** Control-character regex: C0 range (U+0000-U+001F) and DEL (U+007F). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Action a user can assign to one finding in the recovery menu. */
export type FindingAction = 'redact' | 'allow' | 'drop' | 'skip';

/** Prompt function: asks one question and returns the answer. */
export type PromptFn = (prompt: string) => Promise<string>;

/**
 * Build a stable key for a finding used as the actions-map key. Includes the
 * rule id so two findings at the same file/line/column but different rules
 * produce distinct keys and do not collide in the actions map.
 *
 * @param f The gitleaks finding.
 * @returns A colon-delimited key combining file, start line, start column, and rule id.
 */
export function findingKey(f: Finding): string {
  return `${f.File}:${f.StartLine}:${f.StartColumn}:${f.RuleID}`;
}

/** Valid session id charset: alphanumeric, hyphen, underscore (same as cmdDropSession/cmdRedact). */
const VALID_SID = /^[A-Za-z0-9_-]+$/;

/**
 * Extract the session id from a finding's File path. Handles both the flat
 * `shared/projects/<logical>/<sid>.jsonl` form (SESSION_PATH) and the deeper
 * subagent form `shared/projects/<logical>/<sid>/...`. The extracted id is
 * validated against `/^[A-Za-z0-9_-]+$/` before being returned; path-traversal
 * segments (e.g. `..`) are rejected and cause a null return.
 *
 * @param f The gitleaks finding.
 * @returns The session id, or null when the path matches neither pattern or the
 *   extracted id contains characters outside `[A-Za-z0-9_-]`.
 */
export function sessionIdFromFinding(f: Finding): string | null {
  // Try the flat `<sid>.jsonl` form first, then the deeper subagent form. Both
  // patterns capture the session id at group 1; a matched capture group is
  // always a string, so no nullish guard on `m[1]` is needed.
  const m = SESSION_PATH.exec(f.File) ?? /^shared\/projects\/[^/]+\/([^/]+)\//.exec(f.File);
  if (m === null) return null;
  const sid = m[1];
  return VALID_SID.test(sid) ? sid : null;
}

/**
 * Parse a raw prompt answer into a `FindingAction`. Returns `'skip'` for
 * empty, blank, or unrecognized input (D-02 default).
 *
 * @param raw The untrimmed string returned by the prompt.
 * @returns The corresponding action, defaulting to `'skip'`.
 */
export function parseAction(raw: string): FindingAction {
  const t = raw.trim().toLowerCase();
  if (t === 'r' || t === 'redact') return 'redact';
  if (t === 'a' || t === 'allow') return 'allow';
  if (t === 'd' || t === 'drop') return 'drop';
  return 'skip';
}

/**
 * Mask a secret value for safe display. Keeps at most `MASK_LEAD` (4)
 * characters from the start of the secret, then appends a fixed-length mask
 * of `MASK_BODY` (12 asterisks). Non-length-preserving: the output never
 * reveals the secret's full length. An empty input returns the bare mask.
 *
 * @param secret The raw secret string.
 * @returns The masked representation, e.g. `"ghp_************"`.
 */
export function maskSecret(secret: string): string {
  return secret.slice(0, MASK_LEAD) + MASK_BODY;
}

/**
 * Build a one-line display excerpt for a finding, masking the secret span so
 * it can be shown to the user without leaking the raw value.
 *
 * Primary path: `readLine(finding.File, finding.StartLine)` returns the raw
 * source line. The span `StartColumn..EndColumn` (1-indexed inclusive) is
 * extracted, masked via `maskSecret`, and reassembled with up to
 * `CONTEXT_WINDOW` (40) chars of surrounding context on each side. Ellipses
 * are prepended/appended when the context is truncated. Control characters
 * (C0 range and DEL) are stripped from the assembled excerpt.
 *
 * Fallback path: when `readLine` returns null, or the primary excerpt is
 * empty after assembly, the `Finding.Match` field is used: if non-empty,
 * returns `maskSecret(Match)` with control chars stripped; otherwise returns
 * null (no context line).
 *
 * @param finding The gitleaks finding to build context for.
 * @param readLine Injected seam returning the raw 1-indexed source line, or
 *   null on any failure (missing file, out-of-range line).
 * @returns A masked display excerpt, or null when no source is available.
 */
export function buildFindingContext(
  finding: Finding,
  readLine: (file: string, line: number) => string | null,
): string | null {
  const raw = readLine(finding.File, finding.StartLine);

  if (raw !== null) {
    // Clamp columns into [1, raw.length] to handle out-of-range gitleaks output.
    const len = raw.length;
    const startCol = Math.max(1, Math.min(finding.StartColumn, len + 1));
    const endCol = Math.max(startCol, Math.min(finding.EndColumn, len));
    // 0-indexed slice boundaries.
    const spanStart = startCol - 1;
    const spanEnd = endCol; // endCol is inclusive, slice end is exclusive

    const secret = raw.slice(spanStart, spanEnd);
    const masked = maskSecret(secret);

    const fullPrefix = raw.slice(0, spanStart);
    const fullSuffix = raw.slice(spanEnd);

    const prefixTruncated = fullPrefix.length > CONTEXT_WINDOW;
    const suffixTruncated = fullSuffix.length > CONTEXT_WINDOW;

    const prefix = prefixTruncated
      ? fullPrefix.slice(fullPrefix.length - CONTEXT_WINDOW)
      : fullPrefix;
    const suffix = suffixTruncated ? fullSuffix.slice(0, CONTEXT_WINDOW) : fullSuffix;

    const excerpt =
      (prefixTruncated ? '...' : '') + prefix + masked + suffix + (suffixTruncated ? '...' : '');
    const stripped = excerpt.replace(CONTROL_CHARS, '');
    /* c8 ignore start */
    if (stripped.trim().length > 0) return stripped;
    /* c8 ignore stop */
  }

  // Fallback: use the Match field.
  if (finding.Match.length > 0) {
    return maskSecret(finding.Match).replace(CONTROL_CHARS, '');
  }
  return null;
}
