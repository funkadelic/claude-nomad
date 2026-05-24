/**
 * Owns the `nomad doctor --check-shared` preflight reporter.
 *
 * Read-only diagnostic that runs gitleaks against the LOCAL session
 * transcripts `nomad push` would stage (each path-map entry mapped to this
 * host), surfacing secret leaks BEFORE the push pipeline fires. Mirrors the
 * push-time scan (`runGitleaksScan` in `./push-gitleaks.ts`) but: scans a
 * temp COPY of the live transcripts (never the live dir), uses the
 * purpose-built `gitleaks dir` subcommand, and emits doctor-flavored glyph
 * rows + `process.exitCode` instead of throwing a push-flavored FATAL.
 *
 * Composition only: reuses `partitionFindings` / `readGitleaksReport` /
 * `SESSION_PATH` (the gitleaks JSON parser) and `copyDirJsonlOnly` (the
 * push-fidelity source filter) verbatim. The doctor-flavored guidance
 * composer is new (push's `buildSessionAwareFatal` is wrong at doctor time:
 * `nomad drop-session` operates on the staged tree, and nothing is staged
 * during a preflight).
 *
 * All external calls use `execFileSync` argv-array form (no shell), the
 * codebase PUSH-04 invariant.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { green, red, yellow, okGlyph, failGlyph, warnGlyph } from './color.ts';
import { addItem, type DoctorSection } from './commands.doctor.format.ts';
import { CLAUDE_HOME, HOST, REPO_HOME, type PathMap } from './config.ts';
import { partitionFindings, readGitleaksReport, SESSION_PATH } from './push-gitleaks.ts';
import { probeGitleaks } from './push-checks.ts';
import { copyDirJsonlOnly } from './remap.ts';
import { encodePath, nowTimestamp, readJson } from './utils.ts';

/**
 * Build the temp staging tree under `tmpRoot/shared/projects/<logical>/` by
 * copying each local encoded session dir that resolves to a path-map logical
 * for this host. Returns the `logical -> encoded-dir` association so the
 * scrub-path hint can name the live `~/.claude/projects/<encoded>/<sid>.jsonl`
 * file, plus the count of session dirs staged. Skips `TBD`/unmapped entries
 * (the D-03 scope: exactly what `remapPush` would stage). Uses the same
 * depth-0 `*.jsonl` filter as push via `copyDirJsonlOnly`.
 */
function buildScanTree(tmpRoot: string): { logicalToEncoded: Map<string, string>; staged: number } {
  const logicalToEncoded = new Map<string, string>();
  let staged = 0;
  const mapPath = join(REPO_HOME, 'path-map.json');
  if (!existsSync(mapPath)) return { logicalToEncoded, staged };
  const map = readJson<PathMap>(mapPath);
  if (typeof map.projects !== 'object' || map.projects === null) {
    return { logicalToEncoded, staged };
  }

  const reverse = new Map<string, string>();
  for (const [logical, hosts] of Object.entries(map.projects)) {
    if (typeof hosts !== 'object' || hosts === null) continue;
    const p = hosts[HOST];
    if (!p || p === 'TBD') continue;
    reverse.set(encodePath(p), logical);
  }

  const localProjects = join(CLAUDE_HOME, 'projects');
  if (!existsSync(localProjects)) return { logicalToEncoded, staged };
  for (const dir of readdirSync(localProjects)) {
    const logical = reverse.get(dir);
    if (!logical) continue;
    copyDirJsonlOnly(join(localProjects, dir), join(tmpRoot, 'shared', 'projects', logical));
    logicalToEncoded.set(logical, dir);
    staged++;
  }
  return { logicalToEncoded, staged };
}

/**
 * Recover the live encoded-dir for a finding by mapping its `<logical>`
 * segment through the staging association. Returns the absolute live
 * transcript path `~/.claude/projects/<encoded>/<sid>.jsonl`, falling back to
 * the logical name when the association is missing (defensive; the temp-tree
 * model guarantees a hit).
 */
function scrubPath(logical: string, sid: string, logicalToEncoded: Map<string, string>): string {
  const encoded = logicalToEncoded.get(logical) ?? logical;
  return join(CLAUDE_HOME, 'projects', encoded, `${sid}.jsonl`);
}

/**
 * Emit one fail row per affected session plus rotate-and-scrub + allowlist
 * guidance, and set `process.exitCode = 1`. `fileBySession` carries the first
 * finding `File` per session so the `<logical>` segment can be recovered for
 * the scrub-path hint.
 */
function reportSessionFindings(
  section: DoctorSection,
  bySession: Map<string, Map<string, number>>,
  fileBySession: Map<string, string>,
  logicalToEncoded: Map<string, string>,
): void {
  for (const [sid, counts] of bySession) {
    const summary = [...counts.entries()].map(([rule, n]) => `${rule} (${n})`).join(', ');
    addItem(section, `${red(failGlyph)} session ${sid}: ${summary}`);
    const file = fileBySession.get(sid) ?? '';
    const logical = file.startsWith('shared/projects/')
      ? (file.slice('shared/projects/'.length).split('/')[0] ?? sid)
      : sid;
    addItem(
      section,
      `  rotate the credential, then scrub ${scrubPath(logical, sid, logicalToEncoded)}`,
    );
    addItem(section, `  false positive? add a pattern to .gitleaks.toml`);
  }
  process.exitCode = 1;
}

/**
 * Run the `--check-shared` preflight and append its rows to `section`.
 *
 * Flow (D-01..D-10): probe gitleaks (missing -> one WARN row, exit untouched);
 * stage a temp copy of this-host mapped session dirs; scan with the positional
 * `gitleaks dir shared/projects` invocation (NOT `--source`, which `gitleaks
 * dir` rejects with exit 126); on a clean scan emit one ok row reporting the
 * scanned-session count; on findings emit per-session fail rows with
 * rotate-and-scrub guidance and set `process.exitCode = 1`; on a non-zero exit
 * with no parseable report emit a scan-failed fail row + exit 1 (do not chase
 * phantom sessions). Removes both the temp report and the temp tree in
 * `finally` on success and failure. Never writes to stderr (read-only doctor
 * contract).
 */
export function reportCheckShared(section: DoctorSection): void {
  try {
    probeGitleaks();
  } catch {
    addItem(section, `${yellow(warnGlyph)} gitleaks not on PATH; shared scan skipped`);
    return;
  }

  const cacheDir = join(homedir(), '.cache', 'claude-nomad');
  mkdirSync(cacheDir, { recursive: true });
  const stamp = `${nowTimestamp()}-${process.pid}`;
  const reportPath = join(cacheDir, `check-shared-${stamp}.json`);
  const tmpRoot = join(cacheDir, `check-shared-tree-${stamp}`);

  try {
    const { logicalToEncoded, staged } = buildScanTree(tmpRoot);
    if (staged === 0) {
      // No path-map entry maps to this host (or all are TBD). Nothing would be
      // staged by push either, so report clean without invoking gitleaks (a
      // scan of a non-existent dir would exit non-zero and misfire).
      addItem(section, `${green(okGlyph)} 0 sessions scanned, no leaks`);
      return;
    }
    const tomlPath = join(REPO_HOME, '.gitleaks.toml');
    const args: string[] = [
      'dir',
      'shared/projects',
      '--redact',
      '-v',
      '--report-format=json',
      `--report-path=${reportPath}`,
    ];
    if (existsSync(tomlPath)) args.push('--config', tomlPath);

    try {
      execFileSync('gitleaks', args, { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      addItem(section, `${green(okGlyph)} ${staged} sessions scanned, no leaks`);
    } catch {
      const findings = readGitleaksReport(reportPath);
      if (findings === null) {
        addItem(section, `${red(failGlyph)} scan failed: no parseable gitleaks report`);
        process.exitCode = 1;
        return;
      }
      const { bySession } = partitionFindings(findings);
      if (bySession.size === 0) {
        addItem(section, `${green(okGlyph)} ${staged} sessions scanned, no leaks`);
        return;
      }
      const fileBySession = new Map<string, string>();
      for (const f of findings) {
        const m = SESSION_PATH.exec(f.File);
        if (m?.[1] !== undefined && !fileBySession.has(m[1])) fileBySession.set(m[1], f.File);
      }
      reportSessionFindings(section, bySession, fileBySession, logicalToEncoded);
    }
  } finally {
    rmSync(reportPath, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
