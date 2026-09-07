/**
 * The missing `await`, across files.
 *
 * `transform/file.js` propagates async over one file's call graph, and says so:
 *
 *     made async: createUpdateEmpInfo, deleteNotes — callers in other files
 *     must await these
 *
 * That note is the honest edge of a per-file pass. This is the check that reads
 * the whole emitted tree and says whether anyone acted on it.
 *
 * It matters more than it looks. CONVERSION-STRATEGY.md §3 records that a
 * missing `await` is what the *hand* migration got wrong most often, and it is
 * the worst kind of bug to ship: `if (result.length)` on a Promise is `undefined`
 * rather than an error, so the code runs, takes the wrong branch, and writes the
 * wrong data. No compiler sees it. A test against a real database sees it as a
 * wrong answer, not as a stack trace.
 *
 *     node checks/awaits.js <out-dir> [<out-dir> …]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse, walk, parentMap } from '../src/transform/js.js';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!roots.length) {
  process.stderr.write('usage: node checks/awaits.js <out-dir> [<out-dir> …]\n');
  process.exit(2);
}

/** Every .js under a directory. */
function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'gen') jsFiles(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const isFunction = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

let scanned = 0;
const problems = [];
let checkedCalls = 0;

for (const root of roots) {
  const files = jsFiles(root);

  // Pass 1: which exported functions are async, per file.
  const asyncExports = new Map();   // absolute path -> Set of names
  const asts = new Map();
  for (const file of files) {
    let ast;
    try { ast = parse(fs.readFileSync(file, 'utf8'), { filename: file, sourceType: 'module' }); } catch { continue; }
    asts.set(file, ast);
    scanned++;
    const names = new Set();
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.async && n.id) names.add(n.id.name);
      // `export default async function f()` and `export { f }` both reach the
      // declaration above, so only the declarations need collecting.
    });
    asyncExports.set(file, names);
  }

  // Pass 2: every call to a name imported from a file that declares it async.
  for (const [file, ast] of asts) {
    const parents = parentMap(ast);
    /** local binding -> true when it names an async function in the source file */
    const asyncLocals = new Map();

    walk(ast, (n) => {
      if (n.type !== 'ImportDeclaration' || typeof n.source.value !== 'string') return;
      const spec = n.source.value;
      if (!spec.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), spec);
      const names = asyncExports.get(target);
      if (!names) return;
      for (const s of n.specifiers) {
        if (s.type === 'ImportSpecifier' && names.has(s.imported.name)) asyncLocals.set(s.local.name, s.imported.name);
        // A namespace or default import is called as `lib.f(…)`; the member name
        // is what has to be async, and it is checked at the call site below.
        if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') {
          asyncLocals.set(`${s.local.name}.*`, target);
        }
      }
    });
    if (!asyncLocals.size) continue;

    walk(ast, (n) => {
      if (n.type !== 'CallExpression') return;
      let name = null;
      if (n.callee.type === 'Identifier' && asyncLocals.has(n.callee.name)) name = n.callee.name;
      else if (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier') {
        const target = asyncLocals.get(`${n.callee.object.name}.*`);
        if (target && asyncExports.get(target)?.has(n.callee.property.name)) {
          name = `${n.callee.object.name}.${n.callee.property.name}`;
        }
      }
      if (!name) return;
      checkedCalls++;

      // Awaited, returned to an async caller, or handed to a Promise combinator
      // — all three are fine. Anything else drops the Promise on the floor.
      const p = parents.get(n);
      if (p && (p.type === 'AwaitExpression' || p.type === 'ReturnStatement')) return;
      if (p && p.type === 'MemberExpression' && p.object === n && /then|catch|finally/.test(p.property?.name || '')) return;
      if (p && p.type === 'ArrayExpression') {
        const gp = parents.get(p);
        if (gp && gp.type === 'CallExpression') return;     // Promise.all([...])
      }

      // Where the call sits decides whether an await could even be written.
      let fn = null;
      for (let a = parents.get(n); a; a = parents.get(a)) if (isFunction(a)) { fn = a; break; }
      const line = 1 + (fs.readFileSync(file, 'utf8').slice(0, n.start).match(/\n/g) || []).length;
      problems.push({
        file: path.relative(root, file),
        line,
        name,
        why: fn && !fn.async
          ? 'the caller is not async either, so the await has to be added in two places'
          : 'the value is a Promise here, not the result',
      });
    });
  }
}

const num = (s, n) => String(s).padStart(n);
console.log(`\n  ${scanned} emitted .js · ${checkedCalls} cross-file call(s) to an async function`);
if (!problems.length) {
  console.log('  every one of them is awaited.\n');
  process.exit(0);
}
console.log(`\n  ${problems.length} MISSING AWAIT(S):\n`);
for (const p of problems.slice(0, 60)) {
  console.log(`  ${p.file}:${p.line}  ${p.name}()  — ${p.why}`);
}
if (problems.length > 60) console.log(`  … and ${problems.length - 60} more`);
console.log('');
process.exit(1);
