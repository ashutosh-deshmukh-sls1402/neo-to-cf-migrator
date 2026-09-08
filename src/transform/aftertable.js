/**
 * The `afterTableName` payload idiom.
 *
 * An `.xsodata` "create using" exit does not receive the request body. NEO hands
 * it a temporary table instead, names it on `param.afterTableName`, and the
 * handler reads the payload out of it and writes its answer back into it:
 *
 *     after = param.afterTableName;
 *     pstmt = conn.prepareStatement('SELECT PAYLOAD FROM "' + after + '" ');
 *     rs = pstmt.executeQuery();
 *     if (rs.next()) {
 *       oInput = JSON.parse(rs.getNString(1));
 *       …
 *       pstmt = conn.prepareStatement('UPDATE "' + after + '" SET PAYLOAD = ? ');
 *       pstmt.setNString(1, JSON.stringify(returnobj));
 *       pstmt.execute();
 *     }
 *
 * CAP has no such table. The payload arrives on the request — the same `param`,
 * because `service.js` passes `req` straight into the handler — and the answer
 * goes back by returning it:
 *
 *     if (param.data.PAYLOAD !== undefined) {
 *       oInput = JSON.parse(param.data.PAYLOAD);
 *       …
 *       return JSON.stringify(returnobj);
 *     }
 *
 * Converted literally instead, the read becomes a `SELECT` against a table that
 * does not exist and the write becomes an `UPDATE` whose result nobody reads —
 * so the endpoint answers with an empty body. That is 1,354 statements across
 * the three corpora, and it is the shape the hand migration removed everywhere.
 *
 * Nothing here re-derives what `db.js` already resolved. A chain arrives with
 * its SQL folded, its holes located and its column reads named; this only
 * recognises two of those SQL shapes and renders them differently. The request
 * object is *read off the chain*, not guessed: the hole traces to
 * `<name>.afterTableName`, and `<name>` is the parameter CAP passes `req` as.
 */

import { walk } from './js.js';

/** The one interpolated value, as `db.js` marks it. */
const HOLE0 = '__NEO_HOLE_0__';
const READ = new RegExp(`^\\s*SELECT\\s+([A-Za-z_]\\w*)\\s+FROM\\s+"${HOLE0}"\\s*$`, 'i');
const WRITE = new RegExp(`^\\s*UPDATE\\s+"${HOLE0}"\\s+SET\\s+([A-Za-z_]\\w*)\\s*=\\s*\\?\\s*$`, 'i');

const LOOPY = /^(While|DoWhile|For|ForIn|ForOf)Statement$/;

/** `x.afterTableName` → "x". Anything else → null. */
const afterTableOwner = (n) =>
  n && n.type === 'MemberExpression' && !n.computed &&
  n.property.type === 'Identifier' && n.property.name === 'afterTableName' &&
  n.object.type === 'Identifier'
    ? n.object.name
    : null;

/**
 * The request object behind a hole.
 *
 * Either the hole *is* `param.afterTableName`, or it is a variable the function
 * assigned that to — which is how all 1,354 corpus sites are written.
 *
 * `scope` is the enclosing function, not the file: every handler in a library
 * declares its own `after`, and searching file-wide would answer with another
 * function's.
 */
function requestVarOf(holeNode, scope) {
  const direct = afterTableOwner(holeNode);
  if (direct) return { name: direct, assign: null };
  if (holeNode.type !== 'Identifier') return null;

  let owner = null;
  let assign = null;
  walk(scope, (n) => {
    if (owner) return;
    if (n.type === 'AssignmentExpression' && n.operator === '=' &&
        n.left.type === 'Identifier' && n.left.name === holeNode.name) {
      owner = afterTableOwner(n.right);
      if (owner) assign = n;
    } else if (n.type === 'VariableDeclarator' &&
        n.id.type === 'Identifier' && n.id.name === holeNode.name) {
      owner = afterTableOwner(n.init);
      if (owner) assign = n;
    }
  });
  return owner ? { name: owner, varName: holeNode.name, assign } : null;
}

/**
 * Does anything run after this statement, before its function returns?
 *
 * The check walks out to the function body rather than stopping at the
 * immediate siblings, because the write sits inside an `if` more often than not
 * and what follows the `if` runs just the same. A loop on the way out is a
 * refusal outright: a `return` there would leave iterations undone.
 */
function isTail(stmt, parents) {
  for (let n = stmt; n; n = parents.get(n)) {
    const p = parents.get(n);
    if (!p) return true;
    if (/Function/.test(p.type)) return true;
    if (LOOPY.test(p.type)) return false;
    const list = p.type === 'SwitchCase' ? p.consequent : p.body;
    if (!Array.isArray(list)) continue;      // an if/try holds its branches by name
    const i = list.indexOf(n);
    if (i < 0) continue;
    if (!list.slice(i + 1).every((s) => s.type === 'BreakStatement' || s.type === 'EmptyStatement')) return false;
  }
  return true;
}

const enclosingFn = (node, parents) => {
  for (let n = parents.get(node); n; n = parents.get(n)) if (/Function/.test(n.type)) return n;
  return null;
};

/** The name a handler is exported under — what an .xsodata's `create using` names. */
function nameOf(fn, parents) {
  if (!fn) return null;
  if (fn.id?.name) return fn.id.name;
  const p = parents.get(fn);
  if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
  if (p?.type === 'AssignmentExpression' && p.left.type === 'Identifier') return p.left.name;
  return null;
}

/**
 * Mark the chains that are really the payload in and the answer out.
 *
 * Runs before anything is rendered, because the column reads are settled in one
 * pass over every chain in the file (`rowRewrites`) and those reads have to
 * become `req.data.…` rather than a row of a result set.
 *
 * @param {object[]} chains  from `analyseDb`, already resolved
 * @param {{ast:object, parents:Map, statementOf:Function}} ctx
 */
export function classifyAfterTable(chains, ctx) {
  const { ast, parents, statementOf } = ctx;
  const marked = [];

  /** enclosing function -> what this pass takes over inside it */
  const byFn = new Map();

  for (const chain of chains) {
    if (!chain.resolved) continue;
    const holes = chain.sql.interpolated || [];
    if (holes.length !== 1) continue;

    const read = READ.exec(chain.sql.text);
    const write = read ? null : WRITE.exec(chain.sql.text);
    if (!read && !write) continue;

    // A `while (rs.next())` over the payload table is not this shape — one row
    // is the whole point — so it is left to the ordinary conversion.
    if (read && chain.shape === 'loop') continue;
    // The answer is one value bound into the UPDATE. Anything else is not it.
    if (write && (chain.binds.length !== 1 || !chain.binds[0].valueNode || chain.binds[0].spill)) continue;

    const fn = enclosingFn(chain.nodes.create, parents) || ast;
    const req = requestVarOf(holes[0].node, fn);
    if (!req) continue;

    chain.afterTable = {
      kind: read ? 'read' : 'write',
      column: (read || write)[1],
      requestVar: req.name,
      afterVar: req.varName ?? null,
      assign: req.assign,
      fn,
      fnName: nameOf(fn, parents),
    };
    // The statement that note is about is about to be deleted, so it would send
    // a reader hunting for an interpolated table name that is no longer there.
    chain.gaps = chain.gaps.filter((g) => g.code !== 'SQL_IDENTIFIER_INTERPOLATED');
    if (!byFn.has(fn)) byFn.set(fn, []);
    byFn.get(fn).push(chain);
    marked.push(chain);
  }

  // `after = param.afterTableName;` exists only to be spliced into the SQL this
  // pass is deleting. It goes too — but only once nothing else in the function
  // reads it, which is the same rule the SQL variable gets.
  for (const [fn, group] of byFn) {
    const creates = group.map((c) => c.nodes.create);
    const assigns = [...new Set(group.map((c) => c.afterTable.assign).filter(Boolean))];
    for (const chain of group) {
      const { afterVar, assign } = chain.afterTable;
      if (!afterVar || !assign) continue;
      if (!readsOutside(fn, afterVar, creates, assigns, parents)) {
        chain.afterTable.dropAssign = statementOf(assign, parents);
      }
    }
  }

  // One response variable per function, so two writes in one function do not
  // each declare their own.
  const perFn = new Map();
  for (const chain of marked) {
    const at = chain.afterTable;
    if (at.kind !== 'write') continue;
    at.tail = isTail(statementOf(chain.nodes.exec, parents), parents);
    if (at.tail || !at.fn) continue;
    if (!perFn.has(at.fn)) perFn.set(at.fn, { declared: false });
    at.spill = perFn.get(at.fn);
  }

  return marked;
}

/** Is `name` read anywhere in `scope` that this pass is not already deleting? */
function readsOutside(scope, name, claimedCreates, ownAssign, parents) {
  const within = (n, outer) => n.start >= outer.start && n.end <= outer.end;
  let found = false;
  walk(scope, (n) => {
    if (found || n.type !== 'Identifier' || n.name !== name) return;
    if (claimedCreates.some((c) => within(n, c))) return;
    if (ownAssign.some((a) => within(n, a))) return;
    // A bare `var after;` at the top of the function — the corpus declares
    // every local in one list — is a declaration, not a read.
    const p = parents.get(n);
    if (p && p.type === 'VariableDeclarator' && p.id === n && !p.init) return;
    found = true;
  });
  return found;
}

/**
 * The edits for one marked chain, replacing what `chainEdits` would have done.
 *
 * @param {object} chain
 * @param {{source:string, parents:Map, render:Function, statementOf:Function,
 *          removalEdit:Function, indentOf:Function, nameTaken:Function}} ctx
 * @returns {{edits:object[], notes:string[]}}
 */
export function afterTableEdits(chain, ctx) {
  const { source, parents, render, statementOf, removalEdit, indentOf, nameTaken } = ctx;
  const at = chain.afterTable;
  const { nodes } = chain;
  const edits = [];
  const notes = [];

  const drop = (node) => {
    const stmt = node && statementOf(node, parents);
    if (stmt) edits.push(removalEdit(stmt, parents, source));
  };
  drop(nodes.create);
  for (const set of nodes.sets) drop(set);
  if (at.dropAssign) edits.push(removalEdit(at.dropAssign, parents, source));

  const payload = `${at.requestVar}.data.${at.column}`;

  if (at.kind === 'read') {
    // The reads themselves became `req.data.<COLUMN>` in `rowRewrites`; what is
    // left is the statement that fetched the row and the guard around it.
    drop(nodes.exec);
    // `if (rs.next())` asked whether the payload table had a row. On a request
    // that is whether the caller sent the parameter at all.
    if (chain.shape === 'single' && nodes.nexts[0]) {
      edits.push({ start: nodes.nexts[0].start, end: nodes.nexts[0].end, text: `${payload} !== undefined` });
    }
    chain.gaps.push({
      level: 'note',
      code: 'AFTER_TABLE_PAYLOAD',
      message: `The payload NEO read from \`${at.requestVar}.afterTableName\` is \`${payload}\` in CAP; the SELECT against that table is gone.`,
      fix: 'CAP passes the request into the handler, so the temporary "after" table has no equivalent and needs none.',
    });
    return { edits, notes };
  }

  /* --- the write: NEO's answer to the caller --- */
  const value = render(chain.binds[0].valueNode) ?? 'null';
  const stmt = statementOf(nodes.exec, parents);
  const comment = ' // NEO wrote this to the after table; CAP answers with it';

  if (at.tail) {
    edits.push({ start: stmt.start, end: stmt.end, text: `return ${value};${comment}` });
  } else {
    // Code still runs after the write, so the answer cannot leave from here. It
    // is held instead and returned where the function actually ends — which is
    // what the after table was doing: the framework read it once, at the end.
    at.spill.name ??= nameTaken('neoResponse');
    edits.push({ start: stmt.start, end: stmt.end, text: `${at.spill.name} = ${value};${comment}` });
    if (!at.spill.declared) {
      at.spill.declared = true;
      const body = at.fn.body;
      const first = body.body[0];
      const indent = first ? indentOf(first, source) : '  ';
      // Right after the opening brace, not in front of the first statement: the
      // first statement is usually `after = param.afterTableName`, which this
      // pass is deleting, and an insert inside a deleted range disappears.
      const open = body.start + 1;
      edits.push({ start: open, end: open, text: `\n${indent}let ${at.spill.name};` });
      edits.push({ start: body.end - 1, end: body.end - 1, text: `${indent}return ${at.spill.name};\n` });
    }
  }

  chain.gaps.push({
    level: 'note',
    code: 'AFTER_TABLE_RESPONSE',
    message: at.tail
      ? `The UPDATE of \`${at.requestVar}.afterTableName\` was NEO's response body; it is now \`return\`.`
      : `The UPDATE of \`${at.requestVar}.afterTableName\` was NEO's response body, but code runs after it — it is held in \`${at.spill.name}\` and returned where the function ends.`,
    fix: 'Check that this is the value the caller should receive.',
  });
  return { edits, notes };
}

export { isTail, requestVarOf };
