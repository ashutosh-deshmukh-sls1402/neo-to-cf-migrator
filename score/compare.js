/**
 * The scorecard.
 *
 * Given a NEO tree and the CF tree it was hand-migrated into, report how much of
 * that CF tree the tool accounts for. Structural, not textual: does a file exist
 * at the path we produce, and (later) does its content match semantically.
 *
 * It scores **what `convert` actually emits**, not what the layout rules predict
 * it would emit. Those were the same number for a long time and then stopped
 * being: a NEO file whose conversion fails produces no output at all, and the
 * old scorecard still counted its predicted path and could still call it a hit.
 * Running the real pipeline also means one source of truth for the mapping — a
 * change to `targetsFor` cannot pass here and fail there.
 *
 * Three exclusions, or the number lies (SESSION-CONTEXT.md §9):
 *   1. CF files with no NEO ancestor — added by the developer afterwards (D8).
 *   2. Views that drifted when NEO was refreshed 2026-08-11.
 *   3. Known defects in the reference itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/convert.js';
import { classifyFile } from '../src/core/artifacts.js';

const posix = (p) => p.split(path.sep).join('/');
const SKIP = new Set(['.git', 'node_modules', '.vscode', 'graphify-out', 'dist', 'gen']);

/**
 * Files in the CF reference that were written by a developer after the
 * migration, so the tool is not expected to produce them (D8). Matching by
 * basename because the paths differ between projects.
 */
const NO_NEO_ANCESTOR = new Set([
  'ValidationUtil.js', 'rateLimitChecker.js', 'sweepGuard.js', 'hanaIdentifier.js',
  'roleCheckAccess.js', 'custom-service.js', 'datapull-service.js',
  'RoleAssignment.js', 'BootstrapGroups.js', 'AssignDynamicRoles.js', 'ResyncIASUserRoles.js',
  'server.js', 'index.js',
]);

/**
 * The project shell — `package.json`, `mta.yaml` and friends. Emitted from the
 * tree as a whole rather than from any one NEO file, so it belongs to no role
 * and scoring it would measure nothing about the conversion.
 */
const UNSCORED_ROLE = 'project';

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(posix(path.relative(root, abs)));
      }
    }
  }
  return out;
}

/**
 * @param {string} neoRoot
 * @param {string} cfRoot
 * @param {{schema?:string, apps?:string[]}} [opts]
 */
export function score(neoRoot, cfRoot, opts = {}) {
  const run = convert(neoRoot, { schema: opts.schema, apps: opts.apps, config: opts.config });
  const intake = run.intake;
  const actual = new Set(walkFiles(cfRoot));

  // Index by basename too: the reference is known to be inconsistent about the
  // proxy entity name (the same view came out short in one module and fully
  // qualified in another), so a basename hit still tells us the file landed in
  // the right folder.
  const byDir = new Map();
  const byBase = new Set();
  for (const p of actual) {
    const d = posix(path.dirname(p));
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d).add(path.basename(p));
    byBase.add(path.basename(p));
  }

  const roles = {};
  const misses = [];
  const produced = new Set();

  for (const file of run.files) {
    if (file.role === UNSCORED_ROLE) continue;
    const r = (roles[file.role] ||= { predicted: 0, exact: 0, sameDir: 0, missing: 0, dropped: 0, notEmitted: 0 });
    r.predicted++;
    produced.add(file.path);

    if (actual.has(file.path)) {
      r.exact++;
    } else if (!byBase.has(path.basename(file.path))) {
      // Nothing of this name exists anywhere in the reference tree, so there is
      // no file we could be misplacing or misnaming: the hand migration did not
      // carry this NEO file across. TECK has 30 of these — four `test*.xsjs`,
      // the root-level `GetTable*.xsjs`, 13 procedures. Counting them as misses
      // measures the reference's decisions, not ours, so they are separated and
      // left out of the hit rate.
      //
      // This is checked BEFORE the folder test: a dropped file usually shares a
      // folder with files that were kept, which made it read as a naming-rule
      // failure when the naming rule was never consulted.
      r.dropped++;
      misses.push({ role: file.role, predicted: file.path, reason: 'dropped', from: file.source });
    } else if (byDir.has(posix(path.dirname(file.path)))) {
      // Right folder, different file name — the naming rule is off, not the
      // path rule. Worth separating: they have different fixes.
      r.sameDir++;
      misses.push({ role: file.role, predicted: file.path, reason: 'name', from: file.source });
    } else {
      r.missing++;
      misses.push({ role: file.role, predicted: file.path, reason: 'folder', from: file.source });
    }
  }

  // NEO files the run produced nothing for. Scoring emitted files alone would
  // hide these completely — the worst possible outcome scoring as a perfect one.
  const converted = new Set();
  for (const f of run.files) {
    for (const s of String(f.source || '').split(', ')) if (s) converted.add(s);
  }
  const notEmitted = [];
  for (const unit of intake.units) {
    for (const name of unit.files) {
      const rel = unit.neoDir ? `${unit.neoDir}/${name}` : name;
      if (converted.has(rel)) continue;
      const kind = classifyFile(name).kind;
      notEmitted.push({ path: rel, kind });
      const r = (roles[kind] ||= { predicted: 0, exact: 0, sameDir: 0, missing: 0, dropped: 0, notEmitted: 0 });
      r.notEmitted++;
    }
  }

  // The other direction: CF files we never produced. Excludes the developer's
  // later additions (D8), which the tool is not supposed to produce.
  const unexplained = [...actual].filter(
    (p) =>
      /^(db\/src|db\/cds|srv\/lib)\//.test(p) &&
      !produced.has(p) &&
      !NO_NEO_ANCESTOR.has(path.basename(p)),
  );

  return {
    intake,
    roles,
    misses,
    notEmitted: notEmitted.sort((a, b) => a.path.localeCompare(b.path)),
    findings: run.findings,
    actualCount: actual.size,
    unexplained: unexplained.sort(),
  };
}
