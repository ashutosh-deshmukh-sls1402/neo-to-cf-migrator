/**
 * The CDS compiler over the emitted model — the only real oracle for the `.cds`.
 *
 * ARCHITECTURE.md §1 rule 3 says a rule that cannot decide emits a finding
 * rather than a guess. The type map is where that rule has been broken twice,
 * both times in the same way: a type that only had to *look* right got in, and
 * nothing here could tell. `Integer16` does not exist and 64 columns shipped
 * with it; `hana.NCLOB` does not exist either, was assumed by symmetry with
 * `hana.CLOB`, and shipped as well. Both failed at the customer's compile.
 *
 * This closes that loop. Everything else in `checks/` reasons about the output;
 * this hands it to CAP and asks. It found three defects on its first run —
 * `hana.NCLOB`, a column called `KEY` (which the parser reads as the `key`
 * modifier), and a navigation alias written `.Managerql6kfx366e`, which no
 * amount of quoting makes legal.
 *
 * `@sap/cds-compiler` is deliberately NOT a dependency of this repo — the tool
 * has to run where CAP is not installed. So this SKIPs when it cannot be
 * resolved, exactly as `cds build` already does, and is worth installing before
 * a release:
 *
 *     npm i --no-save @sap/cds-compiler
 *     node checks/cdscompile.js <out-dir> [<out-dir> …]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!roots.length) {
  process.stderr.write('usage: node checks/cdscompile.js <out-dir> [<out-dir> …]\n');
  process.exit(2);
}

let compileSources;
try {
  compileSources = createRequire(import.meta.url)('@sap/cds-compiler').compileSources;
} catch {
  console.log('  SKIP  @sap/cds-compiler is not installed (npm i --no-save @sap/cds-compiler)');
  process.exit(0);
}

function cdsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'gen') cdsFiles(p, out); }
    else if (e.name.endsWith('.cds')) out.push(p);
  }
  return out;
}

let failed = 0;

for (const root of roots) {
  // The whole model at once, keyed by its path in the tree, so every
  // `using … from '../../db/cds/…'` resolves the way CAP will resolve it.
  const sources = {};
  for (const dir of ['db', 'srv']) {
    for (const f of cdsFiles(path.join(root, dir))) {
      sources[path.relative(root, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
    }
  }

  try {
    compileSources(sources, {});
    console.log(`${path.basename(root)}: ${Object.keys(sources).length} .cds file(s) compile`);
  } catch (err) {
    const errors = (err.errors ?? []).map((e) => String(e.message ?? e));
    console.log(`${path.basename(root)}: ${errors.length || 1} compile error(s)`);
    // Grouped: one bad rule produces the same message hundreds of times, and
    // the distinct causes are what a reader needs.
    const byKind = new Map();
    for (const m of errors.length ? errors : [err.message]) {
      const kind = m.replace(/“[^”]*”/g, '“…”').split('\n')[0].slice(0, 90);
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(m);
    }
    for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
      console.log(`  ${String(list.length).padStart(5)}  ${kind}`);
      console.log(`         e.g. ${list[0].split('\n')[0].slice(0, 120)}`);
    }
    failed++;
  }
}

process.exit(failed ? 1 : 0);
