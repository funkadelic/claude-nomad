import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { allSharedLinks, claudeHome, repoHome, HOST, type PathMap } from './config.ts';
import { diffLinesToUnified } from './diff-lines.ts';
import { remapExtrasPull } from './extras-sync.ts';
import { stripGsdHookEntries } from './hooks-filter.ts';
import { planSharedLinkDeletions, type SharedLinkDeletion } from './links.deletions.ts';
import { stageLocalSharedEdits, type MirrorPreviewEvent } from './links.mirror.ts';
import { type LinkPreviewEvent, applySharedLinks } from './links.ts';
import { addItem, renderTree, section, type DoctorSection } from './output-tree.ts';
import { buildSkillsPreviewSection } from './preview.skills.ts';
import { type RemapPullPreviewEvent, remapPull, scanLocalOnly } from './remap.ts';
import { summaryRow } from './summary.ts';
import { deepMerge, readJson, sortKeysDeep } from './utils.json.ts';

/**
 * Note emitted when the only settings.json delta is key relocation: the raw
 * stringifications differ but their canonical (sorted-key) forms are equal.
 */
const CANONICAL_ORDER_NOTE =
  'settings.json will be rewritten in canonical key order; no value changes';

/** Verb variants that appear in the Summary row of the preview tree. */
type PreviewVerb = 'pull' | 'diff';

/**
 * The two win32 pre-rebase plans, computed by the caller rather than by
 * `computePreview` itself.
 *
 * Both the deletion planner and the dry-run mirror gate on repo-side state (a
 * deletion needs the repo file to still exist, a capture needs `shared/<name>`
 * to exist), and `pull --dry-run` runs the real `git pull --rebase` before it
 * previews. Computing them inside the preview would therefore evaluate them
 * against a repo the rebase had already moved, while the wet run evaluates
 * them before it, which is exactly the preview-disagrees-with-the-run class
 * the honest-preview rule exists to prevent. A caller that rebases passes the
 * plans it computed beforehand; `nomad diff` has no rebase of its own, so it
 * lets `computePreview` compute them.
 */
export type SharedLinkPlans = {
  /** Mirror events the pre-rebase dry-run mirror emitted for this run. */
  captures: MirrorPreviewEvent[];
  /** Repo-side removals the pre-rebase deletion pass would perform. */
  deletions: SharedLinkDeletion[];
  /**
   * Whether computing these plans already derived the shared-name list, and so
   * already emitted this run's `sharedDirs` rejection WARNs. `computePreview`
   * keeps its own derivation quiet when it did, so one rejected entry is
   * reported once per command rather than once per derivation. False whenever
   * the plans came from a source that derives nothing (every non-win32
   * platform, or an unreadable map), where the preview's own derivation is the
   * only one that ever runs.
   */
  namesDerived: boolean;
  /**
   * The raw `sharedDirs` value `namesDerived`'s WARNs were emitted about.
   *
   * A rebasing caller computes these plans BEFORE its rebase and previews
   * AFTER it, so `namesDerived` alone would suppress a derivation that has a
   * different field to report on. The caller compares this against the map it
   * previews and clears the flag when the two disagree.
   */
  derivedSharedDirs: unknown;
};

/**
 * LCS line diff for two pre-stringified JSON documents via jsdiff. Returns a
 * unified-diff style string: the two literal header lines
 * `--- ~/.claude/settings.json` and `+++ would write`, followed by body lines
 * where unchanged lines are prefixed with a space, removed lines with `-`
 * (red), and added lines with `+` (green). Coloring routes through `color.ts`
 * so `NO_COLOR` / non-TTY environments degrade to literal prefixes with no
 * ANSI escape sequences.
 *
 * Returns the empty string when inputs are byte-identical so the caller can
 * suppress the section. jsdiff `diffLines` aligns on the longest common
 * subsequence, so a mid-document insertion does not cascade false `-`/`+`
 * pairs for the unchanged tail.
 */
export function diffJsonStrings(currentJsonText: string, newJsonText: string): string {
  if (currentJsonText === newJsonText) return '';
  const lines: string[] = [
    '--- ~/.claude/settings.json',
    '+++ would write',
    ...diffLinesToUnified(currentJsonText, newJsonText),
  ];
  return lines.join('\n');
}

/**
 * Read JSON from `path` returning the parsed object, or `null` on any
 * filesystem or parse failure. Used by previewSettings's tolerant read so a
 * malformed settings.json on a fresh-clone host does not abort the preview.
 */
function readJsonOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return readJson<Record<string, unknown>>(path);
  } catch {
    return null;
  }
}

/**
 * Compute the settings.json diff and any edge-case notes without logging.
 * Returns `{ diff, notes }` where `diff` is the unified diff string (`''`
 * when no changes) and `notes` holds human-readable skip/warning messages:
 *   - `'section skipped (base or current missing)'` when base is absent
 *   - `'malformed hosts/<HOST>.json; ignoring overrides'` for a bad host file
 *   - `'malformed; skipping diff'` when current settings.json is unreadable
 *
 * When `diff` is `''` and `notes` is empty, the settings section is omitted
 * by the caller.
 *
 * Both sides have gsd-owned hook entries stripped (via `stripGsdHookEntries`)
 * before comparison so gsd's per-session hook self-heal churn never renders as a
 * phantom hooks delta, matching what `regenerateSettings` writes and mirroring
 * `classifySettingsDrift`. Genuine, non-gsd settings changes still surface.
 *
 * Both sides are canonicalized via `sortKeysDeep` before diffing so a pure key
 * relocation collapses to an empty diff instead of a removed-then-readded
 * cascade; when that happens the `CANONICAL_ORDER_NOTE` is appended so the user
 * still sees that settings.json will be rewritten in sorted-key order.
 * Display-only: the write path (`regenerateSettings`) is untouched.
 *
 * Exported for direct unit testing without the full computePreview harness.
 */
export function previewSettings(
  basePath: string,
  hostPath: string,
  settingsPath: string,
): { diff: string; notes: string[] } {
  const base = readJsonOrNull(basePath);
  if (base === null) {
    return { diff: '', notes: ['section skipped (base or current missing)'] };
  }
  const notes: string[] = [];
  const hostOverrides = readJsonOrNull(hostPath);
  if (hostOverrides === null && existsSync(hostPath)) {
    notes.push(`malformed hosts/${HOST}.json; ignoring overrides`);
  }
  const merged = stripGsdHookEntries(deepMerge(base, hostOverrides ?? {}));
  const current = readJsonOrNull(settingsPath);
  if (current === null && existsSync(settingsPath)) {
    return { diff: '', notes: [...notes, 'malformed; skipping diff'] };
  }
  // Strip gsd-owned hook entries from both sides so gsd's per-session self-heal
  // churn never surfaces as a phantom hooks delta. regenerateSettings already
  // strips them on write, so this also aligns the preview RHS with reality.
  // Mirrors classifySettingsDrift; genuine non-gsd changes still survive.
  const strippedCurrent = stripGsdHookEntries(current ?? {});
  const rawEqual = JSON.stringify(strippedCurrent, null, 2) === JSON.stringify(merged, null, 2);
  const diff = diffJsonStrings(
    JSON.stringify(sortKeysDeep(strippedCurrent), null, 2),
    JSON.stringify(sortKeysDeep(merged), null, 2),
  );
  if (diff === '' && !rawEqual) notes.push(CANONICAL_ORDER_NOTE);
  return { diff, notes };
}

/**
 * Format a link preview event as a Symlinks section row.
 * Examples:
 *   `create    ~/.claude/CLAUDE.md -> /home/user/claude-nomad/shared/CLAUDE.md`
 *   `auto-move ~/.claude/CLAUDE.md -> backup/20260516-000000/CLAUDE.md`
 *   `would copy  ~/.claude/CLAUDE.md -> /home/user/claude-nomad/shared/CLAUDE.md`
 *
 * The `copy` kind (win32 only, see `applySharedLinksWin32`) renders as
 * `would copy` rather than the generic `${kind}` prefix so it reads
 * distinctly from the posix `create`/`auto-move` symlink rows.
 */
function formatLinkRow(e: LinkPreviewEvent): string {
  if (e.kind === 'copy') return `would copy  ${e.from} -> ${e.to}`;
  return `${e.kind}  ${e.from} -> ${e.to}`;
}

/**
 * Format a win32 mirror event (`stageLocalSharedEdits` under `dryRun: true`)
 * as a Symlinks section row. Reads distinctly from the existing rows: the
 * capture runs host-to-repo, the opposite direction from the win32
 * `would copy` row, so the local path is named first.
 * Example: `would capture  ~/.claude/CLAUDE.md -> /repo/shared/CLAUDE.md`
 */
function formatMirrorRow(e: MirrorPreviewEvent): string {
  return `would capture  ${e.localPath} -> ${e.repoPath}`;
}

/**
 * Format a planned win32 deletion (`planSharedLinkDeletions`) as a Symlinks
 * section row: names the repo path that would be removed and the host path
 * whose absence authorized it, so a user reading a dry run understands their
 * sync repo is about to lose that file.
 * Example: `would remove  /repo/shared/commands/a.md (gone from ~/.claude/commands/a.md)`
 */
function formatDeletionRow(d: SharedLinkDeletion): string {
  return `would remove  ${d.repoPath} (gone from ${d.localPath})`;
}

/**
 * Format a remap pull preview event as a Sessions section row. An `overwrite`
 * event renders `overwrite  <dst> (from <src>)`; a `note` event (e.g. nothing
 * to remap) renders its text verbatim. Either way the row is glyph-free.
 *
 * @param e The structured event emitted by `remapPull` under dry-run.
 * @returns The rendered Sessions row text.
 */
function formatSessionRow(e: RemapPullPreviewEvent): string {
  return e.kind === 'overwrite' ? `overwrite  ${e.dst} (from ${e.src})` : e.text;
}

/**
 * Append the win32 capture and removal rows to the Symlinks section, and report
 * whether doing so already emitted this run's `sharedDirs` rejection WARNs.
 *
 * Two sources, matching the two callers of `computePreview`. A caller that
 * rebases (`pull --dry-run`) supplies `plans` computed before its rebase, so
 * the rows are rendered from that pre-collected pair and the WARN accounting
 * comes with it. `nomad diff` has no rebase of its own, so it runs both halves
 * here, against current repo state, deriving the shared-name list ONCE and
 * threading it into both: they run at the same point in the run, so one list is
 * correct for both, and each deriving its own would report a single rejected
 * entry twice.
 *
 * That derivation is deliberately NOT gated on win32, even though both
 * consumers return immediately on darwin and linux. On posix it exists purely
 * to report `sharedDirs` rejections, and it is why this branch returns `true`
 * on every platform: the caller's own `applySharedLinks` then stays quiet, so a
 * rejected entry is still reported exactly once on a posix `nomad diff`, from
 * here rather than from the apply. Sound because `nomad diff` has no rebase, so
 * this derivation and the apply's read the same map. Its rebasing sibling
 * `planSharedReconcileBeforePull` (`commands/pull/win32.ts`) gates its own
 * derivation on win32 for exactly that reason, and moving either one to match
 * the other without moving the suppression with it drops a posix `nomad diff`
 * to zero WARNs.
 *
 * Extracted from `computePreview` so the branch pair does not push that already
 * long function's cognitive complexity up.
 *
 * @param links - The Symlinks section to append rows to.
 * @param ts - Backup timestamp; under dryRun only ever used for phrasing.
 * @param map - Parsed `path-map.json`.
 * @param plans - Pre-rebase plans from a rebasing caller; omit to compute here.
 * @returns Whether the shared-name list has already been derived for this run.
 */
function appendMirrorPlanRows(
  links: DoctorSection,
  ts: string,
  map: PathMap,
  plans?: SharedLinkPlans,
): boolean {
  if (plans) {
    for (const capture of plans.captures) addItem(links, formatMirrorRow(capture));
    for (const deletion of plans.deletions) addItem(links, formatDeletionRow(deletion));
    return plans.namesDerived;
  }
  const linkNames = allSharedLinks(map);
  stageLocalSharedEdits(map, ts, {
    dryRun: true,
    onPreview: (e) => addItem(links, formatMirrorRow(e)),
    linkNames,
  });
  for (const deletion of planSharedLinkDeletions(map, { linkNames })) {
    addItem(links, formatDeletionRow(deletion));
  }
  return true;
}

/**
 * Build the settings.json raw DoctorSection from a previewSettings result.
 * Returns a section with items when there is a diff or notes to show;
 * returns an empty-items section (skipped by renderTree) when both are absent.
 */
function buildSettingsSectionForPreview(result: { diff: string; notes: string[] }) {
  const s = section('settings.json', true);
  if (result.diff !== '') {
    for (const line of result.diff.split('\n')) {
      addItem(s, line);
    }
  }
  for (const note of result.notes) {
    addItem(s, `note: ${note}`);
  }
  return s;
}

/**
 * Orchestrate the dry-run preview across all three sync modalities:
 * symlinks (via applySharedLinks onPreview), settings.json (via deepMerge +
 * diffJsonStrings), and projects (via remapPull onPreview). Renders a
 * glyph-free doctor-style grouped tree:
 *
 *   `would pull on host=<HOST> (preview; nothing applied)`
 *   (blank line)
 *   Symlinks
 *     would capture  <local> -> <repo>   <- win32 only; see the capture/removal note below
 *     would remove   <repo> (gone from <local>)   <- win32 only; same note
 *     create  <from> -> <to>
 *     ...
 *   settings.json        <- RAW section, omitted when no changes
 *     --- ~/.claude/settings.json
 *     +++ would write
 *     ...
 *   Sessions
 *     overwrite  <dst> (from <src>)
 *     <N> local-only present, not in repo (push to reconcile)   <- when N > 0
 *     ...
 *   Skills                 <- omitted when no shared/skills/ dir
 *     <name>
 *     ...
 *     <N> local-only present, not in repo (push to reconcile)   <- when N > 0
 *   Extras                <- omitted when path-map has no extras key
 *     <logical>/<dirname>
 *     ...
 *   Summary
 *     <summaryRow(verb, unmapped + extrasUnmapped, 0, extrasSkipped, localOnly)>
 *
 * The Summary row combines the session-unmapped and extras-unmapped counts,
 * matching the wet pull's Summary for the same starting state.
 *
 * Returns `{ unmapped, collisions, localOnly }` aggregated from remapPull and
 * `scanLocalOnly`. `collisions` is always 0 in this slice. The returned
 * `unmapped` field is session-only (it excludes the extras-unmapped count
 * that the rendered Summary row folds in); callers currently discard it, and
 * keeping it session-only preserves the pre-extras return contract.
 *
 * The Extras section is fed by `remapExtrasPull(ts, { dryRun: true })`'s
 * `wouldPull` detail: under dryRun `runExtrasOp` only collects `would` items
 * (no backup, no copy) and the `.planning` upstream-delete pass is skipped,
 * which is the zero-mutation source for this row. Each row is the raw
 * `<logical>/<dirname>` string with no glyph, keeping it consistent with the
 * rest of this glyph-free tree (contrast the wet `buildExtrasSection`, which
 * prefixes a doctor ok-glyph). An extra whose local project copy does not
 * exist yet still appears here: `wouldPull` keys off the repo `src` existing,
 * not the local `dst`.
 *
 * The local-only row surfaces retained-but-unpushed session leaf files:
 * with retain-merge (`overlaySessionDir`) these entries survive a pull, so the
 * preview reframes a misleading `clean` into an honest count. The scan is
 * read-only (no `cpSync`/`rmSync`/`mkdirSync`), so the dry-run/diff zero-mutation
 * contract holds; the row is plain text (no glyph) to keep the diff tree
 * glyph-free. Both `pull --dry-run` and `nomad diff` route through this single
 * function, so the count is identical on both surfaces.
 *
 * Tolerant by design: missing `shared/settings.base.json` and malformed
 * `~/.claude/settings.json` both produce a note in the settings section and
 * continue rather than throw. This supports `cmdDiff`'s offline-safe contract.
 *
 * The Symlinks section's win32-only `would capture` and `would remove` rows
 * come first, ahead of `applySharedLinks`'s own rows, so the tree reads in
 * the same order the wet pre-pull reconcile executes (capture, then remove,
 * then the repo-to-local overlay). `would remove` renders exactly the
 * `planSharedLinkDeletions` plan the wet pull consumes, computed against the
 * same pre-rebase repo state when the caller supplies `plans` (see
 * {@link SharedLinkPlans}), so preview and pull cannot disagree about what
 * gets removed. `would capture` renders events from the real mirror
 * (`stageLocalSharedEdits` in `links.mirror.ts`) run under `dryRun: true`, so
 * the preview is fed by the same code the wet pull runs rather than by a
 * second predicate that has to be kept honest against it. `nomad diff` calls
 * the mirror directly and streams its events into this section; `pull
 * --dry-run` instead supplies a pre-collected `plans.captures` array, so both
 * plans in {@link SharedLinkPlans} are gathered from the same pre-rebase point
 * in the run for the same reason. Both sources return nothing on any
 * non-win32 platform and on a `null` map, so posix output is unaffected and
 * no branch is needed at either call site. The removal preview reads the
 * host-local shared-links baseline (`links.baseline.ts`) but never writes it:
 * baseline writes happen only on the wet pull path, which this function
 * never reaches, so the zero-mutation contract covers this artifact too.
 *
 * @param ts - backup timestamp (used by applySharedLinks/remapPull for log
 *   phrasing; no backup dir is created under dryRun).
 * @param map - parsed path-map.json; callers fall back to `{ projects: {} }`
 *   when the file is absent.
 * @param verb - 'diff' for cmdDiff, 'pull' for pull --dry-run. Defaults to
 *   'pull' so existing callers compile unchanged.
 * @param plans - Pre-rebase win32 capture and deletion plans; omit to compute
 *   them here against current repo state (see {@link SharedLinkPlans}).
 */
export function computePreview(
  ts: string,
  map: PathMap,
  verb: PreviewVerb = 'pull',
  plans?: SharedLinkPlans,
): { unmapped: number; collisions: number; localOnly: number } {
  const repo = repoHome();
  const claude = claudeHome();
  // "nothing applied", not "no mutation": this header is shared with the
  // dry-run paths, which have already rebased REPO_HOME by the time it prints.
  // What is true in every caller is that nothing reached ~/.claude/.
  console.log(`would pull on host=${HOST} (preview; nothing applied)`);
  console.log('');

  // Symlinks section. Win32-only capture and removal rows first, so the tree
  // reads in the order the wet pre-pull reconcile executes; both sources are
  // read-only under dryRun, return nothing on non-win32 and on a null map,
  // and never write the shared-links baseline (see the docstring above).
  const links = section('Symlinks');
  const namesDerived = appendMirrorPlanRows(links, ts, map, plans);
  applySharedLinks(ts, map, {
    dryRun: true,
    quietNames: namesDerived,
    onPreview: (e) => addItem(links, formatLinkRow(e)),
  });

  // settings.json section (raw, omitted when diff='' and no notes).
  const settingsResult = previewSettings(
    join(repo, 'shared', 'settings.base.json'),
    join(repo, 'hosts', `${HOST}.json`),
    join(claude, 'settings.json'),
  );
  const settingsSection = buildSettingsSectionForPreview(settingsResult);

  // Sessions section.
  const sessions = section('Sessions');
  const remapResult = remapPull(ts, {
    dryRun: true,
    onPreview: (e) => addItem(sessions, formatSessionRow(e)),
  });
  // Honest local-only count: read-only scan of retained-but-unpushed
  // session leaf files. Rendered as a plain-text (glyph-free) Sessions row only
  // when non-zero, so a clean tree still reads 'clean'.
  const localOnly = scanLocalOnly();
  if (localOnly > 0) {
    addItem(sessions, `${localOnly} local-only present, not in repo (push to reconcile)`);
  }

  // Skills section: one glyph-free row per shared/skills/ entry a wet pull
  // would overlay, plus a retained local-only count when non-zero. See
  // buildSkillsPreviewSection's JSDoc for why this section cannot forecast an
  // upstream skill deletion. Read-only; no mutation.
  const skills = buildSkillsPreviewSection();

  // Extras section: one glyph-free row per <logical>/<dirname> a wet pull
  // would copy, sourced from remapExtrasPull's dry-run detail (no backup, no
  // copy, delete pass skipped -- the zero-mutation source for this preview).
  // Only called when both path-map.json and shared/extras/ exist on disk:
  // remapExtrasPull's loadValidatedExtras logs an info line via the shared
  // missingMsg whenever either is absent (mirroring the wet pull path), which
  // would leak onto this otherwise glyph-free surface and violate the
  // "no extras key (or no shared/extras/ dir) preserves current output"
  // contract. An empty `extras` key still resolves silently to zero items.
  const extras = section('Extras');
  let extrasSkipped = 0;
  let extrasUnmapped = 0;
  if (existsSync(join(repo, 'path-map.json')) && existsSync(join(repo, 'shared', 'extras'))) {
    const extrasResult = remapExtrasPull(ts, { dryRun: true });
    for (const entry of extrasResult.wouldPull) {
      addItem(extras, entry);
    }
    extrasSkipped = extrasResult.skipped;
    extrasUnmapped = extrasResult.unmapped;
  }

  // Summary section. Combine session-unmapped and extras-unmapped into one
  // user-visible count, mirroring the wet pull's buildWetPullSections: from
  // the operator's perspective both mean "couldn't sync this for the host",
  // so the preview Summary reads identically to what the wet run will say.
  const summary = section('Summary');
  addItem(
    summary,
    summaryRow(verb, remapResult.unmapped + extrasUnmapped, 0, extrasSkipped, localOnly),
  );

  renderTree([links, settingsSection, sessions, skills, extras, summary]);

  return { unmapped: remapResult.unmapped, collisions: 0, localOnly };
}
