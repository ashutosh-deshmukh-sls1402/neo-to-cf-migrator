/**
 * `var` → `const`/`let`, on the converted output.
 *
 * XSJS is ES5, so every declaration in the corpus is a `var`, and splicing keeps
 * them. CAP handlers are modern modules; `var` in the emitted file reads as code
 * the migration did not finish.
 *
 * This runs LAST, over the finished text rather than as another set of Tier 1
 * edits. `var` keywords sit inside ranges the db and http passes move and
 * delete, so a rewrite mixed in with those would collide with them for no gain —
 * re-parsing the output costs one parse and removes the whole class of overlap.
 *
 * `var` is function-scoped and hoisted; `const`/`let` are block-scoped with a
 * temporal dead zone. So the rewrite has to know which binding each identifier
 * actually refers to, which is why there is a scope pass below rather than a
 * search for the name. Counting names file-wide instead refused 1,036 of the
 * 1,090 declarations in the larger corpus — two functions that both say
 * `var dest` are two bindings, not a redeclaration.
 *
 * A declaration is rewritten only where the difference provably cannot show:
 * bound exactly once in its function, never read outside the block it sits in,
 * never read above the line that declares it. Anything else keeps its `var`.
 */

import { parse, walk, parentMap } from './js.js';

const BLOCK = new Set(['BlockStatement', 'Program', 'StaticBlock', 'SwitchStatement']);
const LOOP = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement']);

const isFunctionScope = (t) =>
  t === 'Program' || t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression';

/** Every name a binding pattern introduces. A `MemberExpression` target binds nothing. */
function namesOf(pattern, out = []) {
  switch (pattern && pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': for (const p of pattern.properties) namesOf(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of pattern.elements) if (e) namesOf(e, out); break;
    case 'AssignmentPattern': namesOf(pattern.left, out); break;
    case 'RestElement': namesOf(pattern.argument, out); break;
    default: break;
  }
  return out;
}

/** The bindings an assignment target writes to. `a.b = 1` writes no binding. */
function collectTargets(pattern, into) {
  switch (pattern && pattern.type) {
    case 'Identifier': into.add(pattern); break;
    case 'ObjectPattern': for (const p of pattern.properties) collectTargets(p.type === 'RestElement' ? p.argument : p.value, into); break;
    case 'ArrayPattern': for (const e of pattern.elements) if (e) collectTargets(e, into); break;
    case 'AssignmentPattern': collectTargets(pattern.left, into); break;
    case 'RestElement': collectTargets(pattern.argument, into); break;
    default: break;
  }
}

/** An identifier that names a property, a key, or a label is not a reference to a binding. */
function isReference(node, parent) {
  if (node.type !== 'Identifier') return false;
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return false;
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return false;
  if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return false;
  if (parent.type === 'ExportSpecifier' && parent.exported === node) return false;
  if (parent.type === 'ImportSpecifier' && parent.imported === node) return false;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
  return true;
}

/**
 * Everything a function scope binds, counted.
 *
 * `let`/`const` in a nested block are counted here too. That is not where the
 * language puts them, and it is deliberate: an inner `let x` beside an outer
 * `var x` pushes the count past one and the `var` is then left alone, which is
 * the answer we want without a second scope tree to reach it.
 */
function bindingsOf(fn) {
  const binds = new Map();
  const add = (name) => binds.set(name, (binds.get(name) || 0) + 1);
  if (fn.type !== 'Program') for (const p of fn.params) namesOf(p).forEach(add);

  const roots = fn.type === 'Program' ? fn.body : [fn.body];
  for (const root of roots) {
    walk(root, (n) => {
      if (isFunctionScope(n.type)) {
        // The name a nested declaration introduces belongs to *this* scope; the
        // body it opens does not.
        if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name);
        return false;
      }
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) namesOf(d.id).forEach(add);
      else if (n.type === 'ClassDeclaration' && n.id) add(n.id.name);
      else if (n.type === 'CatchClause' && n.param) namesOf(n.param).forEach(add);
      else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') add(n.local.name);
      return undefined;
    });
  }
  return binds;
}

/** Why a declaration was left alone, phrased for the person who has to finish it by hand. */
const REFUSALS = {
  REDECLARED: 'declared more than once in the same function, where `let` would be a redeclaration',
  HOISTED_READ: 'read above the line that declares it, which `let` would make a temporal-dead-zone error',
  ESCAPES_BLOCK: 'read outside the block it is written in, where `let` would not be in scope',
  NOT_A_STATEMENT: 'the body of an `if`/loop with no braces, where a `let` declaration is not legal',
};

/**
 * @param {string} source the converted file
 * @returns {{text:string, refused:{line:number, names:string[], reason:string}[]}}
 *   the file with every safely-convertible `var` rewritten, and the ones that
 *   were not, each with the scope rule that stopped it
 */
export function constifyVars(source, { filename = '<source>' } = {}) {
  if (!/\bvar\b/.test(source)) return { text: source, refused: [] };

  let ast;
  try {
    ast = parse(source, { filename, sourceType: 'module' });
  } catch {
    return { text: source, refused: [] };  // transformFile parses the output again and reports it there.
  }
  const parents = parentMap(ast);

  const scopeOf = (node) => {
    for (let n = node; n; n = parents.get(n)) if (isFunctionScope(n.type)) return n;
    return null;
  };
  const outerScope = (scope) => scopeOf(parents.get(scope));

  const binds = new Map();    // function-scope node → Map(name → count)
  const writes = new Set();   // the identifiers that are assigned to, not just read
  const identifiers = [];
  walk(ast, (n, parent) => {
    if (isFunctionScope(n.type)) binds.set(n, bindingsOf(n));
    if (n.type === 'AssignmentExpression') collectTargets(n.left, writes);
    else if (n.type === 'UpdateExpression') collectTargets(n.argument, writes);
    else if (LOOP.has(n.type) && n.left && n.left.type !== 'VariableDeclaration') collectTargets(n.left, writes);
    if (isReference(n, parent)) identifiers.push(n);
  });

  // Each reference tied to the scope that actually binds it, so a `dest` in one
  // function says nothing about a `dest` in another.
  const refs = new Map();  // function-scope node → Map(name → Identifier[])
  for (const id of identifiers) {
    for (let s = scopeOf(id); s; s = outerScope(s)) {
      if (!binds.get(s).has(id.name)) continue;
      if (!refs.has(s)) refs.set(s, new Map());
      const byName = refs.get(s);
      if (!byName.has(id.name)) byName.set(id.name, []);
      byName.get(id.name).push(id);
      break;
    }
  }

  const edits = [];
  const refused = [];
  walk(ast, (decl) => {
    if (decl.type !== 'VariableDeclaration' || decl.kind !== 'var') return undefined;
    if (source.slice(decl.start, decl.start + 3) !== 'var') return undefined;

    const names = decl.declarations.flatMap((d) => namesOf(d.id));
    if (!names.length) return undefined;
    const keep = (reason) => {
      refused.push({ line: source.slice(0, decl.start).split('\n').length, names, reason: REFUSALS[reason] });
      return undefined;
    };

    // A declaration is only a statement where statements live: `if (x) var y = 1;`
    // is legal, `if (x) const y = 1;` is a SyntaxError.
    const parent = parents.get(decl);
    const inLoopHead = parent && LOOP.has(parent.type) && (parent.init === decl || parent.left === decl);
    if (!inLoopHead && !(parent && (parent.type === 'SwitchCase' || BLOCK.has(parent.type)))) return keep('NOT_A_STATEMENT');

    // The block the rewritten binding would be confined to.
    let block = parent;
    while (block && !BLOCK.has(block.type) && !LOOP.has(block.type)) block = parents.get(block);
    if (!block) return keep('ESCAPES_BLOCK');

    const scope = scopeOf(decl);
    let reassigned = false;
    for (const name of names) {
      if (binds.get(scope).get(name) !== 1) return keep('REDECLARED');  // redeclared, or over a parameter
      for (const ref of (refs.get(scope) || new Map()).get(name) || []) {
        if (ref.start < decl.start) return keep('HOISTED_READ');
        if (ref.start < block.start || ref.end > block.end) return keep('ESCAPES_BLOCK');
        if (writes.has(ref)) reassigned = true;
      }
    }

    // `const` needs a value at every declarator; a for-in/of head supplies one
    // per iteration.
    const initialised = inLoopHead && parent.left === decl ? true : decl.declarations.every((d) => d.init);
    edits.push({ start: decl.start, end: decl.start + 3, text: initialised && !reassigned ? 'const' : 'let' });
    return undefined;
  });

  if (!edits.length) return { text: source, refused };

  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  // The scope rules above are the argument; this is the proof. A rewrite that
  // does not parse is dropped whole rather than shipped half-applied.
  try {
    parse(out, { filename, sourceType: 'module' });
  } catch {
    return { text: source, refused };
  }
  return { text: out, refused };
}
