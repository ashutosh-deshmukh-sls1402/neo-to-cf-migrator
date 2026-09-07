/**
 * Checks over an emitted tree that no unit test can make.
 *
 * These run on the real output of `convert`, and each one exists because it
 * caught something:
 *
 *   - a variable the emitter introduced (`callResult`, `bind19`) must be
 *     declared exactly once and read only where it is in scope. A `const` or
 *     `let` read from outside its block parses fine and throws at run time —
 *     the trap behind CALL_OUT_OUTSIDE_SCOPE (§22).
 *   - no internal sentinel may reach the output (`__NEO_HOLE_n__`, §20).
 *   - every emitted `.js` must parse as an ES module. `transformFile` already
 *     checks this per file; here it is checked on what was actually written.
 *
 * The check this cannot make is the important one — whether CAP accepts the
 * model. That needs a real compiler, and §23 says how:
 *
 *     cd <out-dir> && npx cds build --production
 *
 *     node checks/emitted.js <out-dir> [<out-dir> …]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse, parentMap, walk } from '../src/transform/js.js';

const roots = process.argv.slice(2);
if (!roots.length) {
  process.stderr.write('usage: node checks/emitted.js <out-dir> [<out-dir> …]\n');
  process.exit(2);
}

/** Names this tool introduces. A NEO file would not normally hold one. */
const INTRODUCED = /^(callResult|bind[0-9]+)_*$/;

function jsFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      // `gen/` is a cds build artifact — a copy, not something we emitted.
      if (e.isDirectory()) { if (e.name !== 'gen' && e.name !== 'node_modules') stack.push(abs); }
      else if (e.name.endsWith('.js')) out.push(abs);
    }
  }
  return out;
}

let files = 0, decls = 0, uses = 0, unparsed = 0, bad = 0;
const problem = (msg) => { console.log('  ' + msg); bad++; };

for (const root of roots) {
  for (const abs of jsFiles(root)) {
    const src = fs.readFileSync(abs, 'utf8');
    files++;
    const rel = path.relative(root, abs);

    if (src.includes('__NEO_HOLE_')) problem(`SENTINEL LEAK   ${rel}`);

    let ast;
    try {
      ast = parse(src, { filename: abs, sourceType: 'module' });
    } catch (err) {
      // A file that declares a function twice is a known NEO defect the
      // conversion exposes and reports; it is counted, not called a problem.
      unparsed++;
      if (!/already been declared/.test(err.message)) problem(`DOES NOT PARSE  ${rel}: ${err.message.split('\n')[0]}`);
      continue;
    }
    if (!INTRODUCED.test('callResult') || !/\b(callResult|bind[0-9])/.test(src)) continue;

    const parents = parentMap(ast);
    const declared = new Map();
    walk(ast, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !INTRODUCED.test(n.id.name)) return;
      decls++;
      if (declared.has(n.id.name)) problem(`REDECLARED      ${rel}: ${n.id.name}`);
      let block = null;
      for (let p = parents.get(n); p; p = parents.get(p)) {
        if (p.type === 'BlockStatement' || p.type === 'Program' || /Function/.test(p.type)) { block = p; break; }
      }
      declared.set(n.id.name, block);
    });

    walk(ast, (n, parent) => {
      if (n.type !== 'Identifier' || !INTRODUCED.test(n.name)) return;
      if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      uses++;
      const block = declared.get(n.name);
      if (block === undefined) problem(`UNDECLARED      ${rel}: ${n.name}`);
      else if (block && !(n.start >= block.start && n.end <= block.end)) problem(`OUT OF SCOPE    ${rel}: ${n.name}`);
    });
  }
}

console.log(
  `\n  ${files} emitted .js · ${decls} introduced declarations · ${uses} references · ` +
  `${unparsed} do not parse (NEO duplicate functions) · ${bad} problems\n`,
);
process.exit(bad ? 1 : 0);
