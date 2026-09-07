/**
 * Discover the shape of a NEO tree.
 *
 * This is the piece that lets the tool run on NEO alone. The existing cleanup
 * toolkit derives shape from SAP's assistant output; we derive it from the
 * source, so no assistant run is required.
 *
 * Two rules, both learned the hard way in that toolkit:
 *   1. Classify folders by the extensions inside them, never by their name.
 *   2. Where a value cannot be derived, report it — never default silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyFile, classifyFolder, KIND } from './artifacts.js';

const posix = (p) => p.split(path.sep).join('/');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', 'graphify-out', '.vscode']);

/** Every directory under root, with the file names directly inside it. */
function walk(root) {
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — reported by the caller as a gap, not a crash
    }
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        files.push(e.name);
      }
    }
    dirs.push({ abs: dir, rel: posix(path.relative(root, dir)), files });
  }
  return dirs;
}

/**
 * The schema is not a folder — it is the package root, visible only in
 * `$.import("<SCHEMA>.<PKG>", "<Lib>")`. Infer it from the most common first
 * segment across every import in the tree.
 */
function inferSchema(root, dirs) {
  const counts = new Map();
  for (const d of dirs) {
    for (const f of d.files) {
      const c = classifyFile(f);
      if (c.kind !== KIND.LIBRARY) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(d.abs, f), 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(/\$\.import\s*\(\s*["']([^"']+)["']/g)) {
        const first = m[1].split('.')[0];
        if (first) counts.set(first, (counts.get(first) || 0) + 1);
      }
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    schema: ranked.length ? ranked[0][0] : null,
    evidence: ranked.slice(0, 5).map(([name, n]) => ({ name, imports: n })),
  };
}

/**
 * The <APP> segment is dropped from db/ paths but kept under srv/lib, so it has
 * to be identified. A top-level folder is an app when it holds no convertible
 * files of its own but contains artifact folders further down — which is exactly
 * how JOB_BIDDING differs from Env_Config.
 */
function inferApps(units) {
  const topLevel = new Map(); // first segment -> { own: n, deep: n }
  for (const u of units) {
    const segs = u.neoDir.split('/').filter(Boolean);
    if (!segs.length) continue;
    const top = segs[0];
    const e = topLevel.get(top) || { own: 0, deep: 0 };
    if (segs.length === 1) e.own += u.files.length;
    else e.deep += u.files.length;
    topLevel.set(top, e);
  }
  return [...topLevel.entries()]
    .filter(([, e]) => e.own === 0 && e.deep > 0)
    .map(([name]) => name)
    .sort();
}

/**
 * @param {string} root  absolute path to the NEO tree
 * @param {object} [opts]
 * @param {string} [opts.schema] override the inferred schema
 * @param {string[]} [opts.apps] override the inferred app list
 * @returns intake result — see the shape below
 */
export function discover(root, opts = {}) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a folder: ${root}`);
  }

  const dirs = walk(root);
  const units = [];
  const excludedFiles = [];
  const unknownFiles = [];

  for (const d of dirs) {
    if (!d.files.length) continue;
    const c = classifyFolder(d.files);

    for (const name of c.unknown) unknownFiles.push(`${d.rel}/${name}`.replace(/^\//, ''));

    for (const name of d.files) {
      const f = classifyFile(name);
      if (f.known && !f.convert) {
        excludedFiles.push({ path: `${d.rel}/${name}`.replace(/^\//, ''), ext: f.ext, why: f.why });
      }
    }

    // One unit per kind — a folder holding both .xsjslib and .xsodata is two
    // units, not one mislabelled one.
    for (const kind of c.kinds) {
      units.push({
        kind,
        neoDir: d.rel,
        files: d.files.filter((n) => {
          const f = classifyFile(n);
          return f.known && f.convert && f.kind === kind;
        }).sort(),
      });
    }
  }

  units.sort((a, b) => a.neoDir.localeCompare(b.neoDir) || a.kind.localeCompare(b.kind));

  const inferred = inferSchema(root, dirs);
  const schema = opts.schema || inferred.schema;
  const appCandidates = inferApps(units);
  const warnings = [];

  // The <APP> segment is DROPPED from db/ paths, so getting it wrong silently
  // merges unrelated subtrees. TECK has exactly one candidate (JOB_BIDDING) and
  // inference is safe. ICBC has eight — because it has no app layer at all and
  // its top-level folders are modules that become separate CF projects. Dropping
  // all eight would collide DSM/Views with TLW/Views.
  //
  // So: one candidate is inferable, several is an ambiguity to report.
  let apps;
  if (opts.apps) {
    apps = opts.apps;
  } else if (appCandidates.length <= 1) {
    apps = appCandidates;
  } else {
    apps = [];
    warnings.push({
      code: 'APP_AMBIGUOUS',
      message:
        `Cannot infer the <APP> segment: ${appCandidates.length} top-level folders look ` +
        `like candidates (${appCandidates.join(', ')}).`,
      fix:
        'Pass --app <name> if one of these really is the application wrapper, or leave it ' +
        'unset if this tree has no app layer and its top-level folders are modules. ' +
        'The <APP> segment is dropped from db/ paths, so guessing here would merge ' +
        'unrelated subtrees.',
      candidates: appCandidates,
    });
  }

  if (!schema) {
    warnings.push({
      code: 'SCHEMA_UNKNOWN',
      message: 'Could not infer the schema — no $.import statements were found.',
      fix: 'Pass --schema <name>. It is the first segment of the $.import package path.',
    });
  }

  const foreign = inferred.evidence.filter((e) => e.name !== schema);
  if (foreign.length) {
    warnings.push({
      code: 'FOREIGN_SCHEMA_IMPORTS',
      message:
        `Imports reference other schemas: ${foreign.map((f) => `${f.name} (${f.imports})`).join(', ')}.`,
      fix:
        'These are cross-container references. They cannot be resolved inside this tree and ' +
        'will need a synonym or an explicit decision before deploy.',
    });
  }

  // Two .xsodata in one folder both map to that folder's single service.cds.
  // TECK has two such folders (JB_SUPVR/JB_ALLJBPSTNG and
  // JB_UNION_ADMIN/JB_JBPOSTPRTL), so this is not hypothetical: without a
  // decision, the second silently overwrites the first.
  for (const u of units) {
    if (u.kind === KIND.SERVICE && u.files.length > 1) {
      warnings.push({
        code: 'SERVICE_SHARED_FOLDER',
        message:
          `${u.neoDir} holds ${u.files.length} .xsodata files (${u.files.join(', ')}), ` +
          `which all become service blocks in one service.cds.`,
        fix:
          'A .cds file holds any number of service blocks, each with its own path, so this converts. ' +
          'Check the generated paths are the ones the UI calls.',
        neoDir: u.neoDir,
        files: u.files,
      });
    }
  }

  // A section is the parent of one or more artifact folders — the unit of work
  // a human thinks in ("the HR module"), used for reporting and for --only.
  const sections = new Map();
  for (const u of units) {
    const parent = u.neoDir.split('/').slice(0, -1).join('/') || '(root)';
    const s = sections.get(parent) || { path: parent, units: [] };
    s.units.push(u);
    sections.set(parent, s);
  }

  const counts = {};
  for (const u of units) counts[u.kind] = (counts[u.kind] || 0) + u.files.length;

  return {
    root,
    schema,
    schemaInferred: !opts.schema,
    schemaEvidence: inferred.evidence,
    apps,
    appsInferred: !opts.apps,
    appCandidates,
    warnings,
    units,
    sections: [...sections.values()].sort((a, b) => a.path.localeCompare(b.path)),
    counts,
    excludedFiles,
    unknownFiles,
    totals: {
      convertible: Object.values(counts).reduce((a, b) => a + b, 0),
      excluded: excludedFiles.length,
      unknown: unknownFiles.length,
    },
  };
}
