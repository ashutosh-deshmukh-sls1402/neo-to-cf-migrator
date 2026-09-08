/**
 * Does every `CALL` in the emitted JavaScript name a procedure we emitted?
 *
 * The two sides of that question are computed independently and must agree:
 *
 *   db/src   `PROCEDURE "…"`      from the .hdbprocedure header, flattened by
 *                                 emit/hdbprocedure.js
 *   srv/lib  `cds.run('CALL …')`  from the NEO repository path in the handler,
 *                                 flattened by transform/emitdb.js
 *
 * They agree because both flatten the same NEO qualified name, and the call is
 * left unquoted so HANA folds it to the upper case the declaration is stored in.
 * Nothing enforces that but this check — and if it ever drifts, nothing fails
 * until the procedure is called at run time, in production, with a
 * "procedure not found" that names an object the tree appears to contain.
 *
 *     node checks/procnames.js <out-dir> [<out-dir> …]
 */

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!roots.length) {
  process.stderr.write('usage: node checks/procnames.js <out-dir> [<out-dir> …]\n');
  process.exit(2);
}

function files(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'gen') files(p, ext, out); }
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

let problems = 0;

for (const root of roots) {
  const declared = new Set();
  for (const f of files(path.join(root, 'db', 'src'), '.hdbprocedure')) {
    const m = /\bPROCEDURE\s+"([^"]+)"/i.exec(fs.readFileSync(f, 'utf8'));
    if (m) declared.add(m[1].toUpperCase());
  }

  /** name -> the first handler that calls it */
  const called = new Map();
  for (const f of files(path.join(root, 'srv', 'lib'), '.js')) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bCALL\s+([A-Za-z_][\w]*)\s*\(/g)) {
      const name = m[1].toUpperCase();
      if (!called.has(name)) called.set(name, path.relative(root, f));
    }
  }

  const missing = [...called].filter(([name]) => !declared.has(name));
  console.log(`${path.basename(root)}: ${declared.size} procedure(s), ${called.size} distinct CALL target(s), ${missing.length} unresolved`);
  for (const [name, from] of missing) console.log(`  ${name}\n    called from ${from}`);
  // An unresolved CALL is usually a NEO-side dangling reference — a path that
  // was already wrong before the migration — so it is reported, not failed on.
  // What must never happen is our two sides disagreeing about a procedure that
  // IS here, which shows up as a name declared but under a different spelling.
  problems += missing.filter(([name]) =>
    [...declared].some((d) => d.replace(/_/g, '') === name.replace(/_/g, ''))).length;
}

if (problems) {
  console.log(`\n${problems} CALL(s) name a procedure this tree declares under a different spelling.`);
  process.exit(1);
}
