/**
 * `await`, propagated across the whole emitted tree.
 *
 * `transform/file.js` derives async over ONE file's call graph and then says,
 * honestly, where it has to stop:
 *
 *     made async: createUpdateEmpInfo, deleteNotes — callers in other files
 *     must await these
 *
 * On the two corpora that note covered **1,266 call sites**. Every one of them
 * would have shipped as a Promise used as a value: `if (rows.length)` on a
 * Promise is `undefined`, so the code does not crash — it takes the wrong branch
 * and writes the wrong data. CONVERSION-STRATEGY.md §3 records this as the
 * mistake the *hand* migration made most often, and nothing catches it: not the
 * parser, not `cds build`, not a smoke test. It shows up as a wrong answer.
 *
 * `convert` is the only place that has every file at once, so this is where the
 * per-file pass gets finished. It reads the JavaScript the tool has *already
 * emitted*, resolves each import to the file it names, and runs one fixed point
 * over the whole call graph:
 *
 *     a call to an async function needs `await`
 *       → the function containing that call is async
 *         → so do its callers, in this file and every other
 *
 * Nothing here guesses. An import that does not resolve to an emitted file, a
 * call through a variable, a function this cannot name — each is left alone and
 * counted, because a missing `await` is a bug and an invented one is a worse bug.
 */

import path from 'node:path';
import { parse, walk, parentMap, applyEdits } from '../transform/js.js';

const isFunction = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

/** Normalised key for a function: which file, which name. */
const key = (file, name) => `${file}::${name}`;

/**
 * Resolve `./x.js` from `srv/lib/A/b.js` to `srv/lib/A/x.js`, in the same
 * repo-relative, forward-slash form the emitted files are keyed by.
 */
function resolveSpec(fromPath, spec) {
  if (!spec.startsWith('.')) return null;
  const joined = path.posix.join(path.posix.dirname(fromPath), spec);
  return joined.endsWith('.js') ? joined : `${joined}.js`;
}

/**
 * @param {{path:string, text:string, role:string}[]} files  everything `convert` emitted
 * @returns {{files:object[], awaited:number, asyncified:number, skipped:string[]}}
 */
export function propagateAwaits(files) {
  const js = files.filter((f) => f.path.endsWith('.js') && f.role !== 'project');
  const skipped = [];

  /* ---- 1. parse, and index every named function ---- */
  const parsed = new Map();          // path -> { ast, parents, text }
  const fns = new Map();             // key -> { file, name, node, async }
  const exportsOf = new Map();       // path -> Set of exported names

  for (const f of js) {
    let ast;
    try {
      ast = parse(f.text, { filename: f.path, sourceType: 'module' });
    } catch {
      // Already reported by the re-parse gate in transformFile; not this pass's
      // business, and a file we cannot read is a file we must not edit.
      skipped.push(f.path);
      continue;
    }
    parsed.set(f.path, { ast, parents: parentMap(ast), text: f.text, file: f });

    const exported = new Set();
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id) {
        fns.set(key(f.path, n.id.name), { file: f.path, name: n.id.name, node: n, async: !!n.async });
      }
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFunction(n.init)) {
        fns.set(key(f.path, n.id.name), { file: f.path, name: n.id.name, node: n.init, async: !!n.init.async });
      }
      if (n.type === 'ExportNamedDeclaration') {
        for (const s of n.specifiers || []) exported.add(s.exported.name);
        const d = n.declaration;
        if (d?.type === 'FunctionDeclaration' && d.id) exported.add(d.id.name);
        for (const v of d?.declarations || []) if (v.id.type === 'Identifier') exported.add(v.id.name);
      }
      // `export default { a, b }` — the object literal an .xsjslib becomes.
      if (n.type === 'ExportDefaultDeclaration' && n.declaration?.type === 'ObjectExpression') {
        for (const p of n.declaration.properties) {
          const name = p.key?.name || p.key?.value;
          if (name) exported.add(name);
        }
      }
    });
    exportsOf.set(f.path, exported);
  }

  /* ---- 2. every call site, resolved to the function it reaches ---- */
  const calls = [];                  // { file, node, target, inside }
  for (const [file, { ast, parents }] of parsed) {
    /** local name -> { target } for `import { f }`, `ns.*` for namespace/default */
    const bindings = new Map();
    walk(ast, (n) => {
      if (n.type !== 'ImportDeclaration' || typeof n.source.value !== 'string') return;
      const target = resolveSpec(file, n.source.value);
      if (!target || !parsed.has(target)) return;
      for (const s of n.specifiers) {
        if (s.type === 'ImportSpecifier') bindings.set(s.local.name, key(target, s.imported.name));
        else bindings.set(`${s.local.name}.*`, target);      // default or namespace
      }
    });

    walk(ast, (n) => {
      if (n.type !== 'CallExpression') return;
      let target = null;
      if (n.callee.type === 'Identifier') {
        target = bindings.get(n.callee.name) || (fns.has(key(file, n.callee.name)) ? key(file, n.callee.name) : null);
      } else if (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier') {
        const ns = bindings.get(`${n.callee.object.name}.*`);
        if (ns) target = key(ns, n.callee.property.name);
      }
      if (!target || !fns.has(target)) return;

      // Which function is this call inside? That is what becomes async.
      let inside = null;
      for (let a = parents.get(n); a; a = parents.get(a)) {
        if (!isFunction(a)) continue;
        for (const [k, v] of fns) if (v.node === a) { inside = k; break; }
        break;                        // the *nearest* function, named or not
      }
      calls.push({ file, node: n, target, inside, parents });
    });
  }

  /* ---- 3. one fixed point over the whole graph ---- */
  const isAsync = new Set([...fns].filter(([, v]) => v.async).map(([k]) => k));
  for (let changed = true; changed;) {
    changed = false;
    for (const c of calls) {
      if (!isAsync.has(c.target) || !c.inside || isAsync.has(c.inside)) continue;
      isAsync.add(c.inside);
      changed = true;
    }
  }

  /* ---- 4. edits ---- */
  let awaited = 0;
  let asyncified = 0;
  const edits = new Map();           // path -> edit[]
  const add = (file, e) => { if (!edits.has(file)) edits.set(file, []); edits.get(file).push(e); };

  for (const c of calls) {
    if (!isAsync.has(c.target)) continue;
    const p = c.parents.get(c.node);
    if (p?.type === 'AwaitExpression') continue;
    // Already handled by the caller: returned to an async caller, or given to a
    // Promise combinator. Both keep the Promise, deliberately.
    if (p?.type === 'MemberExpression' && p.object === c.node && /^(then|catch|finally)$/.test(p.property?.name || '')) continue;
    // Only a function that can hold an `await` gets one. A call at module top
    // level would need top-level await, which changes when the module finishes
    // loading — not a decision to make silently.
    if (!c.inside) continue;

    // `await f().x` parses as `(await f()).x` — but only when the await binds
    // first, which it does not if something to the right binds tighter.
    const needsParens = p && (
      (p.type === 'MemberExpression' && p.object === c.node) ||
      (p.type === 'CallExpression' && p.callee === c.node) ||
      (p.type === 'TaggedTemplateExpression' && p.tag === c.node)
    );
    add(c.file, { start: c.node.start, end: c.node.start, text: needsParens ? '(await ' : 'await ' });
    if (needsParens) add(c.file, { start: c.node.end, end: c.node.end, text: ')' });
    awaited++;
  }

  for (const k of isAsync) {
    const fn = fns.get(k);
    if (!fn || fn.async) continue;                // already async in the emitted text
    add(fn.file, { start: fn.node.start, end: fn.node.start, text: 'async ' });
    asyncified++;
  }

  /* ---- 5. splice, and prove the result still parses ---- */
  const failed = [];
  for (const [file, list] of edits) {
    const entry = parsed.get(file);
    const next = applyEdits(entry.text, list);
    try {
      parse(next, { filename: file, sourceType: 'module' });
    } catch (err) {
      // Never ship a file this pass broke. The un-awaited version is wrong at
      // run time; an unparseable one is wrong immediately, and worse.
      failed.push({ file, message: err.message.split('\n')[0] });
      continue;
    }
    entry.file.text = next;
  }

  return { files, awaited, asyncified, skipped, failed };
}
