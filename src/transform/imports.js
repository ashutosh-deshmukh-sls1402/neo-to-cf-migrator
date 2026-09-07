/**
 * `$.import` → ES modules.
 *
 * The single most common idiom left after the database tier: 331 `$.import`
 * calls and 328 references to what they bring in, across the two corpora. NEO
 * writes it in two halves that have to be read together:
 *
 *     $.import("TECK.Env_Config", "CommonUtil");        // registers it
 *     var libEnvAth = $.TECK.Env_Config.CommonUtil;     // names it
 *
 * CAP writes that as one line:
 *
 *     import libEnvAth from "../../../../../Env_Config/handlers/CommonUtil.js";
 *
 * The specifier is computed from the emitted layout, not guessed — the package
 * path already starts with the schema, so `TECK.Env_Config` + `CommonUtil` is
 * `srv/lib/TECK/Env_Config/handlers/CommonUtil.js`, and `importSpecifier` makes
 * it relative to wherever *this* file lands. That reproduces the shipped CF's
 * five-level climb exactly.
 *
 * The `$.import` calls are the authority on where a package name ends and a
 * library name begins. `$.TECK.JOB_BIDDING.EncryptionDecryption.AES.AESENCODEDEODE.CryptoJS`
 * is a member *of* a library, not a deeper library, and nothing in the path
 * itself says so — only the matching `$.import` does.
 */

import { walk } from './js.js';
import { targetsFor, importSpecifier } from '../core/layout.js';
import { KIND } from '../core/artifacts.js';

/** The `$.a.b.c` path of a member expression rooted at `$`, or null. */
function dollarPath(node) {
  const segs = [];
  let cur = node;
  while (cur.type === 'MemberExpression' && !cur.computed && cur.property.type === 'Identifier') {
    segs.unshift(cur.property.name);
    cur = cur.object;
  }
  return cur.type === 'Identifier' && cur.name === '$' && segs.length ? segs : null;
}

const isDollarImport = (n) =>
  n.type === 'CallExpression' &&
  n.callee.type === 'MemberExpression' &&
  !n.callee.computed &&
  n.callee.object.type === 'Identifier' &&
  n.callee.object.name === '$' &&
  n.callee.property.name === 'import';

const literal = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null);

/** Where a NEO package + library lands in the emitted tree. */
export function handlerTargetFor(pkg, lib, schema) {
  // The package already carries the schema as its first segment, which is what
  // makes this a straight mapping rather than a reconstruction.
  const dir = pkg.split('.').filter(Boolean).join('/');
  const [first] = pkg.split('.');
  return {
    path: `srv/lib/${dir}/handlers/${lib}.js`,
    foreign: schema ? first.toUpperCase() !== String(schema).toUpperCase() : false,
  };
}

/**
 * @param {{source:string, ast:object, parents:Map, opts:object, nameTaken:Function}} ctx
 * @returns {{edits:object[], notes:string[], imports:object[], findings:object[]}}
 */
export function importEdits(ctx) {
  const { source, ast, parents, opts, nameTaken, statementOf, removalEdit } = ctx;
  const edits = [];
  const notes = [];
  const findings = [];
  const imports = [];

  const { relPath, schema } = opts;
  if (!relPath || !schema) {
    return { edits, notes, imports, findings };   // nothing to resolve against
  }
  const selfPath = targetsFor({ relPath, kind: KIND.LIBRARY, schema, app: null })[0].path;

  // 1. The registrations, which say where each package name ends.
  const registered = new Map();   // "TECK.Env_Config.CommonUtil" -> {pkg, lib}
  const registrations = [];
  walk(ast, (n) => {
    if (!isDollarImport(n)) return;
    const pkg = literal(n.arguments[0]);
    const lib = literal(n.arguments[1]);
    registrations.push({ node: n, pkg, lib });
    if (!pkg || !lib) {
      findings.push({
        level: 'warning',
        code: 'IMPORT_NOT_LITERAL',
        message: '`$.import` is called with something other than two string literals, so the module it loads cannot be resolved.',
        fix: 'Convert this import by hand.',
      });
      return;
    }
    registered.set(`${pkg}.${lib}`, { pkg, lib });
  });

  if (!registrations.length) return { edits, notes, imports, findings };

  // 2. Every reference to something registered. Longest match wins, so a member
  //    of a library is not mistaken for a deeper library.
  const keys = [...registered.keys()].sort((a, b) => b.length - a.length);
  const aliasFor = new Map();   // key -> local name
  const refs = [];

  walk(ast, (node) => {
    if (node.type !== 'MemberExpression') return;
    const parent = parents.get(node);
    if (parent && parent.type === 'MemberExpression' && parent.object === node) return;  // only the outermost
    const segs = dollarPath(node);
    if (!segs) return;
    const dotted = segs.join('.');
    const key = keys.find((k) => dotted === k || dotted.startsWith(k + '.'));
    if (!key) return;

    // The node covering exactly the library, which is what an alias replaces.
    let libNode = node;
    const depth = key.split('.').length;
    while (libNode.type === 'MemberExpression' && dollarPath(libNode).length > depth) libNode = libNode.object;
    refs.push({ node, libNode, key, whole: dotted === key });
  });

  // 3. `var alias = $.PKG.LIB;` gives the module its name; anything else needs one.
  for (const ref of refs) {
    if (aliasFor.has(ref.key)) continue;
    const parent = parents.get(ref.node);
    if (ref.whole && parent && parent.type === 'VariableDeclarator' && parent.init === ref.node && parent.id.type === 'Identifier') {
      aliasFor.set(ref.key, parent.id.name);
      ctx.reserve(parent.id.name);
    }
  }
  for (const ref of refs) {
    if (!aliasFor.has(ref.key)) aliasFor.set(ref.key, nameTaken(registered.get(ref.key).lib));
  }

  // 4. Emit one import per library, and rewrite or delete every reference.
  const seen = new Set();
  for (const ref of refs) {
    const { pkg, lib } = registered.get(ref.key);
    const alias = aliasFor.get(ref.key);
    if (!seen.has(ref.key)) {
      seen.add(ref.key);
      const target = handlerTargetFor(pkg, lib, schema);
      if (target.foreign) {
        findings.push({
          level: 'warning',
          code: 'FOREIGN_PACKAGE_IMPORT',
          message: `\`${pkg}\` is not under schema ${schema}, so the module it points at is outside this conversion.`,
          fix: 'Check that the imported library is being migrated too, then fix the import path by hand.',
        });
      }
      imports.push({ alias, specifier: importSpecifier(selfPath, target.path), pkg, lib });
    }

    const parent = parents.get(ref.node);
    const declaresAlias =
      ref.whole && parent && parent.type === 'VariableDeclarator' &&
      parent.init === ref.node && parent.id.type === 'Identifier' && parent.id.name === alias;

    if (declaresAlias) {
      const stmt = statementOf(ref.node, parents);
      if (stmt) edits.push(removalEdit(stmt, parents, source));   // the import line replaces it
    } else {
      edits.push({ start: ref.libNode.start, end: ref.libNode.end, text: alias });
    }
  }

  // 5. The registrations themselves have no equivalent — the import is the import.
  for (const r of registrations) {
    const stmt = statementOf(r.node, parents);
    if (stmt) edits.push(removalEdit(stmt, parents, source));
  }

  if (imports.length) notes.push(`resolved ${imports.length} $.import(…) to ES imports`);
  const unused = registrations.filter((r) => r.pkg && r.lib && !seen.has(`${r.pkg}.${r.lib}`));
  if (unused.length) {
    notes.push(`dropped ${unused.length} $.import(…) whose module is never used`);
  }

  return { edits, notes, imports, findings };
}

/**
 * The export block a converted `.xsjslib` needs.
 *
 * The shipped CF exports libraries twice — `export default { … }` for consumers
 * that import the whole module and `export { … }` for the generated `service.js`,
 * which imports the one entry function by name. Emitting both means either
 * import style resolves.
 *
 * `.xsjs` files are request entry points, not libraries; what they export
 * depends on the request boundary, which is a separate transform.
 */
export function exportedNames(ast) {
  return [...new Set(ast.body.filter((n) => n.type === 'FunctionDeclaration' && n.id).map((n) => n.id.name))];
}

export function exportBlock(ast, relPath) {
  if (!relPath || !relPath.endsWith('.xsjslib')) return null;
  const unique = exportedNames(ast);
  if (!unique.length) return null;
  const list = unique.map((n) => `  ${n},`).join('\n');
  return `\nexport default {\n${list}\n};\n\nexport {\n${list}\n};\n`;
}
