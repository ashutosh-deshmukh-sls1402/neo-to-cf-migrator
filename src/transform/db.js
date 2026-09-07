/**
 * JDBC chain analysis — the highest-value module in the tool.
 *
 * TECK has 505 `prepareStatement` and 225 `prepareCall` sites across 73 files.
 * Every one of them is the same shape spread over five to twenty lines:
 *
 *     conn  = $.db.getConnection();
 *     q     = 'SELECT A, B FROM T WHERE C = ?';
 *     pstmt = conn.prepareStatement(q);
 *     pstmt.setNString(1, x);
 *     rs    = pstmt.executeQuery();
 *     while (rs.next()) { out.push(rs.getNString(1)); }
 *
 * CAP writes that as one line plus a loop over named columns. Getting there
 * needs data flow, not text matching: the SQL is in a *variable* declared
 * earlier, the binds arrive through *later* calls on the statement handle, and
 * `getNString(1)` only means `A` if you have read the SELECT list.
 *
 * This module does that analysis and stops. It emits no code. It returns one
 * `chain` per statement — the facts — and, where the facts are incomplete, a
 * `gaps` list saying exactly what could not be decided. Emission reads chains;
 * the AI tier reads the same chains as its FACTS block; a chain with gaps is a
 * hole for a human. One analysis, three consumers.
 *
 * The rule the whole tool runs on applies here hardest: a chain that cannot be
 * resolved deterministically reports a gap. It never guesses a column name.
 */

import { parse, walk, parentMap, enclosingFunction } from './js.js';
import { scan, KIND } from '../parse/sqlscript.js';
import { lookupProcedure } from '../parse/procsig.js';

/** JDBC setters. We only need to know that they bind, not what they bind to. */
const SETTERS = new Set([
  'setNString', 'setString', 'setInteger', 'setInt', 'setBigInt', 'setDouble', 'setDecimal',
  'setNull', 'setDate', 'setTime', 'setTimestamp', 'setClob', 'setNClob', 'setBlob',
  'setBoolean', 'setReal', 'setSmallInt', 'setTinyInt', 'setFloat', 'setText',
]);

const GETTERS = new Set([
  'getNString', 'getString', 'getInteger', 'getInt', 'getBigInt', 'getDouble', 'getDecimal',
  'getDate', 'getTime', 'getTimestamp', 'getClob', 'getNClob', 'getBlob', 'getBoolean',
  'getReal', 'getSmallInt', 'getTinyInt', 'getFloat', 'getText',
]);

const EXECUTORS = new Set(['executeQuery', 'executeUpdate', 'execute']);
const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);

/* ────────────────────────────── SQL reading ────────────────────────────── */

/**
 * Blank out strings and comments while preserving every offset, so structural
 * scanning cannot be fooled by a `FROM` inside a literal. Quoted identifiers
 * are kept: `"COLUMN"` is exactly what we are trying to read.
 */
function maskSql(sql) {
  let out = '';
  for (const seg of scan(sql)) {
    out += seg.kind === KIND.CODE || seg.kind === KIND.QUOTED_IDENT
      ? seg.text
      : seg.text.replace(/[^\n]/g, ' ');
  }
  return out.length === sql.length ? out : sql;
}

/** select | call | update (insert/update/delete/…) | other */
export function statementKind(sql) {
  const head = maskSql(sql).replace(/^[\s(]+/, '').slice(0, 24).toUpperCase();
  if (head.startsWith('SELECT')) return 'select';
  if (head.startsWith('CALL')) return 'call';
  if (/^(INSERT|UPDATE|DELETE|UPSERT|MERGE|REPLACE)\b/.test(head)) return 'update';
  return 'other';
}

/** Split on commas that sit at paren depth zero, keeping offsets. */
function splitTop(masked, offset) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push({ start: offset + from, end: offset + i }); from = i + 1; }
  }
  parts.push({ start: offset + from, end: offset + masked.length });
  return parts;
}

const unquote = (s) => s.replace(/^"(.*)"$/, '$1');

/** The name of one select-list item, or null when it has none. */
function itemName(text) {
  const item = text.trim().replace(/\s+/g, ' ');
  if (!item || item === '*' || item.endsWith('.*')) return null;
  // The expression before AS is masked away to spaces when it is a string
  // literal, so the alias can begin the item; requiring \s here would miss it.
  const aliased = /(?:^|\s)AS\s+("[^"]+"|[\w$#]+)$/i.exec(item);
  if (aliased) return unquote(aliased[1]).toUpperCase();
  // A plain column, optionally table-qualified and optionally quoted.
  const plain = /^(?:("[^"]+"|[\w$#]+)\s*\.\s*)?("[^"]+"|[\w$#]+)$/.exec(item);
  if (plain) return unquote(plain[2]).toUpperCase();
  // `COUNT(*) N` — an implicit alias. Only trusted when what precedes it is a
  // closed expression, otherwise a trailing keyword would be read as a name.
  const implicit = /^(.*\))\s+("[^"]+"|[\w$#]+)$/.exec(item);
  if (implicit) return unquote(implicit[2]).toUpperCase();
  return null;
}

/**
 * The projected columns of a SELECT, with the source offsets of each item.
 * @returns {{start:number, end:number, name:string|null, star:boolean}[] | null}
 */
function selectList(sql) {
  const masked = maskSql(sql);
  const head = /^[\s(]*SELECT\s+(?:(?:DISTINCT|ALL)\s+)?(?:TOP\s+\d+\s+)?/i.exec(masked);
  if (!head) return null;

  // The FROM that closes the select list is the first one at paren depth zero;
  // anything deeper belongs to a subquery.
  let depth = 0;
  let fromAt = -1;
  for (let i = head[0].length; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch) && /^from(\s|$)/i.test(masked.slice(i + 1, i + 6))) { fromAt = i + 1; break; }
  }
  const listEnd = fromAt === -1 ? masked.length : fromAt;   // SELECT without FROM is legal in HANA
  const start = head[0].length;

  return splitTop(masked.slice(start, listEnd), start).map((p) => {
    // Read the item from the masked text: comments and string literals are
    // blanks there, so a trailing `-- note` cannot be mistaken for an alias and
    // `codeEnd` lands before it rather than inside it.
    const code = masked.slice(p.start, p.end);
    const trimmed = code.trim();
    return {
      ...p,
      name: itemName(code),
      star: trimmed === '*' || trimmed.endsWith('.*'),
      codeEnd: p.start + code.replace(/\s+$/, '').length,
    };
  });
}

/**
 * The column name each 1-based `getX(n)` refers to.
 *
 * Returns one entry per projected column, `null` where the name cannot be known
 * (`SELECT *`, an unaliased expression). A null is not a failure of this
 * function — it is the honest answer, and the caller turns it into a gap.
 *
 * @returns {(string|null)[] | null} null when the statement is not a SELECT
 */
export function selectColumns(sql) {
  const list = selectList(sql);
  return list ? list.map((c) => c.name) : null;
}

/**
 * Name the unnamed columns of a SELECT by adding aliases to the SQL itself.
 *
 * `SELECT count(*) FROM T` gives a result column whose name HANA invents; CAP
 * hands back rows keyed by that invented name, which nothing can rely on. The
 * fix a developer would apply by hand is to write `AS COL1`, and since this SQL
 * is ours to rewrite and no caller outside the converted function ever sees the
 * column names, we can apply it ourselves. Semantics are unchanged.
 *
 * `SELECT *` is left alone — a star cannot be aliased, and inventing names for
 * columns we have not seen is exactly the guessing this tool refuses to do.
 *
 * @returns {{sql:string, columns:(string|null)[], aliased:{index:number,name:string,expr:string}[]}|null}
 */
export function aliasUnnamedColumns(sql) {
  const list = selectList(sql);
  if (!list) return null;

  const taken = new Set(list.map((c) => c.name).filter(Boolean));
  const aliased = [];
  let out = '';
  let cursor = 0;

  list.forEach((c, i) => {
    if (c.name || c.star) return;
    let name = `COL${i + 1}`;
    while (taken.has(name)) name = `${name}_`;
    taken.add(name);
    out += sql.slice(cursor, c.codeEnd) + ` AS ${name}`;
    cursor = c.codeEnd;
    aliased.push({ index: i + 1, name, expr: sql.slice(c.start, c.end).trim() });
  });

  const rewritten = out + sql.slice(cursor);
  return { sql: rewritten, columns: selectColumns(rewritten), aliased };
}

/* ──────────────────────────── AST helpers ──────────────────────────── */

const calleeName = (node) =>
  node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
    ? node.callee.property.name
    : null;

/**
 * A stable name for a reference expression: `rs`, `param.connection`, `this.stmt`.
 *
 * Handles are not always plain variables. Two thirds of the corpus reaches the
 * connection through a parameter object — `param.connection.prepareStatement(q)`
 * — and keying on identifiers alone made those statements invisible rather than
 * unresolved, which is the one failure mode this tool must not have. Anything
 * not a plain dotted path (a call, a computed index) returns null and is
 * reported instead of quietly dropped.
 */
export function refPath(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const base = refPath(node.object);
    return base ? `${base}.${node.property.name}` : null;
  }
  return null;
}

/** The reference a call's value is assigned to: `x = f()` or `var x = f()`. */
function assignedTo(node, parents) {
  const p = parents.get(node);
  if (!p) return null;
  if (p.type === 'VariableDeclarator' && p.init === node) return refPath(p.id);
  if (p.type === 'AssignmentExpression' && p.right === node) return refPath(p.left);
  return null;
}

/** True when `node` sits inside `ancestor`. */
const within = (node, ancestor) => node.start >= ancestor.start && node.end <= ancestor.end;

/** The nearest enclosing loop within the same function, or null. */
function enclosingLoop(node, parents) {
  for (let n = parents.get(node); n; n = parents.get(n)) {
    if (LOOPS.has(n.type)) return n;
    if (/Function/.test(n.type)) return null;
  }
  return null;
}

/**
 * Where a variable stops meaning what it meant: the first assignment to `name`
 * after `after`, or Infinity.
 *
 * Reusing one `rs` for several queries in a row is ordinary XSJS, and without
 * this bound a chain claims the *next* query's getters as its own — which is how
 * `getNString(6)` ends up attributed to a one-column SELECT.
 */
function nextAssignment(name, scopeNode, after) {
  let best = Infinity;
  walk(scopeNode, (n) => {
    if (n.start <= after) return;
    const hit =
      (n.type === 'AssignmentExpression' && refPath(n.left) === name) ||
      (n.type === 'VariableDeclarator' && refPath(n.id) === name && n.init);
    if (hit && n.start < best) best = n.start;
  });
  return best;
}

/** The statements of an `if` branch, whether or not it is a block. */
const branchStatements = (node) => (node ? (node.type === 'BlockStatement' ? node.body : [node]) : []);

/** The bind a statement is, or null. */
function bindOf(stmt, stmtVar) {
  if (!stmt || stmt.type !== 'ExpressionStatement') return null;
  const e = stmt.expression;
  if (e.type !== 'CallExpression' || e.callee.type !== 'MemberExpression' || e.callee.computed) return null;
  if (refPath(e.callee.object) !== stmtVar || !SETTERS.has(e.callee.property.name)) return null;
  const [idxArg, valArg] = e.arguments;
  if (!idxArg || idxArg.type !== 'Literal' || typeof idxArg.value !== 'number') return null;
  return { index: idxArg.value, setter: e.callee.property.name, valueNode: valArg || null, node: e };
}

/**
 * An `if` read as a decision tree over binds — nothing else on any branch, at
 * any depth.
 *
 *   { test, then: <tree>, else: <tree> }        a branch
 *   { binds: Map(index -> bind) }               a leaf
 *
 * Returns null the moment a branch does anything but bind this statement, or
 * has no `else`: a missing `else` leaves the parameter holding whatever it held
 * before, which is not a value any expression can name.
 */
function bindDecisionTree(node, stmtVar) {
  if (node && node.type === 'IfStatement') {
    if (!node.alternate) return null;
    const then = bindDecisionTree(node.consequent, stmtVar);
    const alt = bindDecisionTree(node.alternate, stmtVar);
    if (!then || !alt) return null;
    return { test: node.test, then, else: alt, node };
  }
  const stmts = branchStatements(node);
  if (!stmts.length) return null;
  // A branch that is a single nested `if` recurses; otherwise every statement
  // in it has to be a bind. Mixing the two in one branch is refused — the
  // ordering between them would have to be preserved and an expression cannot.
  if (stmts.length === 1 && stmts[0].type === 'IfStatement') return bindDecisionTree(stmts[0], stmtVar);
  const binds = new Map();
  for (const s of stmts) {
    const b = bindOf(s, stmtVar);
    if (!b || binds.has(b.index)) return null;
    binds.set(b.index, b);
  }
  return { binds };
}

/** Every leaf of a decision tree, in source order. */
function treeLeaves(t, out = []) {
  if (t.binds) out.push(t);
  else { treeLeaves(t.then, out); treeLeaves(t.else, out); }
  return out;
}

/** The tree for ONE parameter: the same shape, with a value at each leaf. */
const valueTreeFor = (t, index) =>
  t.binds
    ? { value: t.binds.get(index).valueNode }
    : { test: t.test, then: valueTreeFor(t.then, index), else: valueTreeFor(t.else, index) };

/**
 * Render a value tree as a conditional expression.
 *
 * `renderValue` is supplied by the caller: the analysis renders from the NEO
 * source, the emitter renders with every other pass's rewrites already applied.
 */
export function renderValueTree(t, renderValue) {
  if ('value' in t) return renderValue(t.value) ?? 'null';
  // Right-associative in JS, so the parentheses are not required — but a bare
  // `a ? b ? x : y : z` is not something anyone should have to read.
  const then = 'value' in t.then ? renderValueTree(t.then, renderValue) : `(${renderValueTree(t.then, renderValue)})`;
  return `${renderValue(t.test)} ? ${then} : ${renderValueTree(t.else, renderValue)}`;
}

/**
 * The parameters an `if` cannot be folded for, handled by keeping the `if`.
 *
 * This is the shape the ternary fold cannot take, and it is the common one —
 * the branch binds *and does something else*:
 *
 *     if (rs.getNString(19) && record.JPSTS === '6') {
 *         cstmt.setNString(19, rs.getNString(19) || '');
 *     } else {
 *         cstmt.setNull(19);
 *         logError(pstmtErr, srvName, record, "CLOSR can't be null …");
 *     }
 *
 * Collapsing that into a conditional expression would drop `logError`. But the
 * branch is not really choosing *control flow*, it is choosing a *value*, so the
 * `if` can stay exactly where it is and each setter become an assignment:
 *
 *     let bind19;
 *     if (…) { bind19 = rs.getNString(19) || ''; }
 *     else   { bind19 = null; logError(…); }
 *     await cds.run(`…`, [ …, bind19, … ]);
 *
 * The semantics are JDBC's own: whichever assignment runs last before the
 * execute is the value that is bound, exactly as the last `setX` won before.
 * Nothing is reordered and no branch is lost, which is why this works for
 * shapes the fold refuses — separate `if`s, `else if` chains, a plain
 * overwrite.
 *
 * Refused when a bind sits in a loop the execute is not in (that is
 * `BIND_BATCHED` — values accumulating across iterations, not a choice), or
 * when the setter is not a statement of its own, or when it is not in the same
 * block as the execute, which is where the declaration has to go.
 */
function spillConditionalBinds(binds, exec, parents, statementOfNode) {
  if (!exec) return { binds: [...binds], spills: [] };

  const execStmt = statementOfNode(exec.node);
  if (!execStmt) return { binds: [...binds], spills: [] };
  const host = parents.get(execStmt);
  if (!host || (host.type !== 'BlockStatement' && host.type !== 'Program')) return { binds: [...binds], spills: [] };
  const execLoop = enclosingLoop(exec.node, parents);

  /** The statement in `host` that contains `node`, or null. */
  const topOf = (node) => {
    for (let n = node, p = parents.get(n); p; n = p, p = parents.get(p)) {
      if (p === host) return n;
      if (/Function/.test(p.type)) return null;
    }
    return null;
  };

  const byIndex = new Map();
  for (const b of binds) {
    if (!byIndex.has(b.index)) byIndex.set(b.index, []);
    byIndex.get(b.index).push(b);
  }

  const spills = [];
  const gone = new Set();
  for (const [index, list] of byIndex) {
    if (list.length < 2) continue;
    const tops = [];
    let ok = true;
    for (const b of list) {
      const stmt = parents.get(b.node);
      const top = topOf(b.node);
      const loop = enclosingLoop(b.node, parents);
      if (!top || b.node.start > exec.node.start ||
          !stmt || stmt.type !== 'ExpressionStatement' || stmt.expression !== b.node ||
          (loop && loop !== execLoop && !(execLoop && within(execLoop, loop)) && !within(exec.node, loop))) {
        ok = false;
        break;
      }
      tops.push(top);
    }
    if (!ok) continue;

    const anchor = tops.reduce((a, t) => (t.start < a.start ? t : a));
    spills.push({ index, sites: list.map((b) => ({ node: b.node, valueNode: b.valueNode, setter: b.setter })), anchor });
    for (const b of list) gone.add(b);
  }

  // A fresh array either way — the caller splices its own list from this, and
  // returning the same reference would leave it clearing what it then reads.
  if (!spills.length) return { binds: [...binds], spills };
  const kept = binds.filter((b) => !gone.has(b));
  for (const s of spills) {
    kept.push({
      index: s.index,
      setter: s.sites[0].setter,
      isNull: s.sites.every((x) => x.setter === 'setNull'),
      valueText: `<chosen by ${s.sites.length} branches>`,
      spill: s,
      node: s.anchor,
    });
  }
  return { binds: kept.sort((a, b) => a.index - b.index), spills };
}

/**
 * Fold an `if` that only chooses bind values into one bind per parameter.
 *
 *   if (c) stmt.setX(4, a); else stmt.setNull(4);          ->  c ? a : null
 *   if (c) { if (d) set(3,x); else set(3,''); } else set(3,'');
 *                                                          ->  c ? (d ? x : '') : ''
 *
 * The second shape is why this is a tree rather than a pair. 81 of the 120
 * remaining conditional binds are nested `if`s of that kind; the flat pair was
 * only ever the easy half.
 *
 * Two conditions, both necessary:
 *
 *   - every branch, at every depth, does nothing but bind this statement, and
 *     every `if` in the tree has an `else`;
 *   - every leaf binds *the same set of parameters*. A parameter bound on one
 *     path and not another keeps its previous value on that path, and no
 *     expression can express that.
 *
 * Outermost `if` first, so a tree is folded whole rather than from the middle.
 */
function foldConditionalBinds(binds, stmtVar, source, parents) {
  const roots = [];
  const seen = new Set();
  for (const b of binds) {
    for (let n = b.node, p = parents.get(n); p; n = p, p = parents.get(p)) {
      if (/Function/.test(p.type)) break;
      if (p.type === 'IfStatement' && (p.consequent === n || p.alternate === n) && !seen.has(p)) {
        seen.add(p);
        roots.push(p);
      }
    }
  }
  roots.sort((a, b) => a.start - b.start || b.end - a.end);   // outermost first

  const byNode = new Map(binds.map((b) => [b.node, b]));
  const folded = [];
  const consumedIfs = new Set();
  const gone = new Set();

  for (const root of roots) {
    if ([...consumedIfs].some((c) => within(root, c))) continue;    // already inside a folded tree
    const tree = bindDecisionTree(root, stmtVar);
    if (!tree) continue;

    const leaves = treeLeaves(tree);
    const first = [...leaves[0].binds.keys()].sort((a, b) => a - b);
    const sameEverywhere = leaves.every(
      (l) => l.binds.size === first.length && first.every((i) => l.binds.has(i)),
    );
    if (!sameEverywhere) continue;

    // Every bind this tree contains must be one we are tracking, and no bind of
    // these parameters may sit outside it — otherwise folding would drop a
    // later assignment.
    const inside = leaves.flatMap((l) => [...l.binds.values()]);
    if (!inside.every((b) => byNode.has(b.node))) continue;
    if (binds.some((b) => first.includes(b.index) && !within(b.node, root))) continue;

    for (const index of first) {
      const vt = valueTreeFor(tree, index);
      const leafBinds = leaves.map((l) => l.binds.get(index));
      folded.push({
        index,
        setter: leafBinds[0].setter,
        isNull: leafBinds.every((b) => b.setter === 'setNull'),
        valueText: renderValueTree(vt, (n) => (n ? source.slice(n.start, n.end) : 'null')),
        conditional: true,
        tree: vt,
        node: root,
      });
    }
    for (const b of inside) gone.add(byNode.get(b.node));
    consumedIfs.add(root);
  }

  // Always a fresh array: the caller splices its own list from this result, and
  // returning the same reference would leave it clearing what it then reads.
  if (!folded.length) return { binds: [...binds], consumedIfs };
  return { binds: [...binds.filter((b) => !gone.has(b)), ...folded].sort((a, b) => a.index - b.index), consumedIfs };
}

/**
 * Resolve a SQL expression node to static text.
 *
 * Follows one hop through an identifier, which is how every file in the corpus
 * writes it (`q1 = '…'`, then `prepareStatement(q1)`).
 */
/** Flatten a `+` chain into its operands, left to right. */
function plusOperands(node, out = []) {
  if (node && node.type === 'BinaryExpression' && node.operator === '+') {
    plusOperands(node.left, out); plusOperands(node.right, out);
  } else out.push(node);
  return out;
}

/**
 * Where an interpolated value sits in the SQL built so far.
 *
 * This is the whole reason most "dynamic" SQL is not an AI problem. Counting
 * quotes from the start of the statement says which of three things the value
 * is, and they convert three different ways:
 *
 *   …WHERE NAME = '  ⟩ value       — a bind parameter: `?`
 *   …FROM "          ⟩ identifier  — a table or column name, which SQL cannot
 *                                    bind, so it has to be interpolated
 *   …LIMIT           ⟩ bare        — could be either; not worth guessing
 */
export const HOLE = (i) => `__NEO_HOLE_${i}__`;

function holePosition(sqlSoFar) {
  if ((sqlSoFar.match(/'/g) || []).length % 2 === 1) return 'value';
  if ((sqlSoFar.match(/"/g) || []).length % 2 === 1) return 'identifier';
  return 'bare';
}

/**
 * A concatenation read as a template: the literal text, with a hole for every
 * run-time value and a note of where each hole sits.
 *
 * Returns null when an operand is something other than a constant or a plain
 * reference — a call, an index, a ternary — which stays genuinely dynamic.
 */
function foldTemplate(node, source, scopeNode, before) {
  const parts = plusOperands(node);
  if (parts.length < 2) return null;

  let sql = '';
  const holes = [];
  for (const p of parts) {
    if (!p) return null;
    const r = resolveSql(p, source, scopeNode, before);
    if (r.static) { sql += r.text; continue; }
    holes.push({ node: p, position: holePosition(sql), at: sql.length });
    sql += HOLE(holes.length - 1);
  }
  if (!holes.length) return null;
  return { sql, holes };
}

/**
 * Decide, hole by hole, what a run-time value in the SQL becomes.
 *
 * §20 handled the case where *every* hole is an identifier. The rest were
 * refused wholesale, and measuring the 96 that remained (§26) showed most of
 * them are one of three shapes with a deterministic answer:
 *
 *   WHERE USER_NAME = '<hole>'        the hole is a whole string literal
 *                                     → `?` and a bind, inserted into the
 *                                       existing bind order by text position
 *   WHERE ID NOT IN ('<a.join>')      the hole carries its own quotes and
 *                                     commas → interpolate, exactly as NEO did
 *   CREATE USER <hole> WITH IDENTITY '<hole>'
 *                                     DDL takes no bind parameters at all
 *                                     → interpolate both, note both
 *
 * Anything else — a hole that is only part of a literal, a bare hole in DML,
 * a list built up in a loop — still refuses. Returns null to say so.
 */
function planHoles(t, isDDL, source, kinds = null) {
  const kept = [];
  const binds = [];
  const notes = [];
  let usedModel = false;
  let out = '';
  let pos = 0;

  const note = (h, message, fix, byModel) => {
    const expr = source.slice(h.node.start, h.node.end);
    notes.push({
      code: h.position === 'value' ? 'SQL_VALUE_INTERPOLATED' : 'SQL_IDENTIFIER_INTERPOLATED',
      level: 'note',
      // Anything a model decided says so, in the finding the developer reads.
      // Tier 1's answers and Tier 2's must never be indistinguishable.
      message: message(expr) + (byModel ? ' **The AI tier classified this hole** — check it.' : ''),
      fix: fix(expr),
    });
  };

  for (const [i, h] of t.holes.entries()) {
    const ph = HOLE(i);
    const at = t.sql.indexOf(ph, pos);
    if (at === -1) return null;
    // A value hole is bindable only when it spans a whole string literal. A
    // hole inside one — `LIKE '%<hole>%'` — would need the pattern rebuilt.
    const whole = t.sql[at - 1] === "'" && t.sql[at + ph.length] === "'";
    // `a.join("','")` produces `x','y`: quotes and commas of its own, so it is
    // a list of values, not one. Binding it would compare against the whole
    // string. Interpolating it is what NEO did and is exactly faithful.
    const isList = /\.\s*join\s*\(/.test(source.slice(h.node.start, h.node.end));

    // What Tier 1 can decide on its own, it decides. A model answer never
    // overrides quote parity — it only settles the cases quote parity leaves
    // open, which is what `bare` means (§28).
    const said = kinds?.[i];
    const decidable = h.position === 'identifier' || (h.position === 'value' && whole) || (h.position === 'bare' && isDDL);
    let action;
    if (h.position === 'identifier') action = 'interpolate';
    else if (h.position === 'bare' && isDDL) action = 'interpolate';
    else if (h.position === 'value' && whole) action = isDDL || isList ? 'interpolate' : 'bind';
    else if (said === 'identifier' || said === 'list') action = 'interpolate';
    // A value hole that is only *part* of a literal — `LIKE '%<hole>%'` — cannot
    // be bound however confident the model is: the pattern would have to be
    // rebuilt around the parameter, and those quotes are not ours to move.
    else if (said === 'value' && h.position === 'value') action = null;
    else if (said === 'value') action = isDDL ? 'interpolate' : 'bind';
    else action = null;
    if (!action) return null;
    const byModel = !!said && !decidable;
    if (byModel) usedModel = true;

    if (action === 'interpolate') {
      out += t.sql.slice(pos, at) + HOLE(kept.length);
      kept.push(h);
      pos = at + ph.length;
      if (h.position === 'identifier' || said === 'identifier') {
        note(h,
          (e) => `\`${e}\` names a table or column, so it is written into the SQL text rather than bound — SQL cannot parameterise an identifier.`,
          (e) => `Check that \`${e}\` cannot carry a caller-supplied value. If it can, validate it against a known list of names before it reaches this statement.`,
          byModel);
      } else if (isDDL) {
        note(h,
          (e) => `\`${e}\` is written into the SQL text rather than bound: this is DDL, which takes no bind parameters.`,
          (e) => `Check that \`${e}\` cannot carry a caller-supplied value.`,
          byModel);
      } else {
        note(h,
          (e) => `\`${e}\` builds a list or a fragment of SQL, so it is written into the SQL text rather than bound — one \`?\` cannot stand for it.`,
          (e) => `Check that the values in \`${e}\` cannot carry a caller-supplied quote. To parameterise it, expand the list into one \`?\` per element.`,
          byModel);
      }
      continue;
    }

    // The quotes around the literal go with it: `= '<hole>'` becomes `= ?`. A
    // bare hole — `LIMIT <hole>` — has none to take.
    const quoted = h.position === 'value' && whole ? 1 : 0;
    out += t.sql.slice(pos, at - quoted) + '?';
    pos = at + ph.length + quoted;
    binds.push({ index: (maskSql(out).match(/\?/g) || []).length, valueNode: h.node, node: h.node, fromHole: true });
  }
  out += t.sql.slice(pos);
  return { sql: out, interpolated: kept, binds, notes, byModel: usedModel };
}

function resolveSql(node, source, scopeNode, before) {
  if (node.type === 'Literal' && typeof node.value === 'string') return { text: node.value, static: true };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { text: node.quasis[0].value.cooked, static: true };
  }

  // `'SELECT A, ' + 'B FROM T'` is one constant written across several lines —
  // 60 of the corpus's 103 "dynamic" statements are exactly this. Fold it.
  // A `+` with a non-constant operand stays dynamic, which is the honest answer:
  // that one really is assembled at run time.
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = resolveSql(node.left, source, scopeNode, before);
    const r = resolveSql(node.right, source, scopeNode, before);
    if (l.static && r.static) return { text: l.text + r.text, static: true, folded: true };
    const template = foldTemplate(node, source, scopeNode, before);
    return {
      text: source.slice(node.start, node.end),
      static: false,
      template,
      reason: 'string concatenation with a run-time value',
    };
  }

  const ref = refPath(node);
  if (ref) {
    // The last assignment to this reference before the prepare, in the same scope.
    let best = null;
    walk(scopeNode, (n) => {
      if (n.start >= before) return;
      const isDecl = n.type === 'VariableDeclarator' && refPath(n.id) === ref && n.init;
      const isAssign = n.type === 'AssignmentExpression' && refPath(n.left) === ref;
      if (isDecl || isAssign) {
        const value = isDecl ? n.init : n.right;
        if (!best || n.start > best.start) best = { start: n.start, value, node: n, compound: isAssign && n.operator !== '=' };
      }
    });
    // `query += ' GROUP BY …'` does not *define* `query`, it appends to it. Its
    // right-hand side is a fragment, and reading it as the statement produced
    // `cds.run('GROUP BY CS.CMGID')` — a confident, silently wrong conversion,
    // which is the one outcome this tool exists to avoid. The value is
    // assembled at run time, which is what SQL_DYNAMIC has always meant.
    if (best?.compound) {
      return {
        text: source.slice(node.start, node.end),
        static: false,
        via: ref,
        reason: `\`${ref}\` is built up with \`${best.node.operator}\``,
      };
    }
    if (best) {
      const inner = resolveSql(best.value, source, scopeNode, best.start);
      // The reference and its assignment travel with the result so the emitter
      // can delete the assignment once the SQL has moved into the cds.run call.
      // `varName`/`assign` travel even when the text is not static yet: a
      // template whose holes all turn out to be interpolable becomes static
      // below, and its assignment is then just as dead as any other.
      return { ...inner, varName: ref, assign: best.node, ...(inner.static ? {} : { via: ref }) };
    }
    return { text: source.slice(node.start, node.end), static: false, reason: `unresolved reference \`${ref}\`` };
  }

  return { text: source.slice(node.start, node.end), static: false, reason: node.type };
}

/* ──────────────────────────── the analysis ──────────────────────────── */

/**
 * @param {string} source a .xsjs or .xsjslib file
 * @returns {{chains: object[], connections: object[]}}
 */
export function analyseDb(source, { filename = '<source>', program, procs = null, schema = null, holeKinds = null } = {}) {
  const ast = program || parse(source, { filename });
  const parents = parentMap(ast);

  const connections = [];
  const creations = [];
  const memberCalls = [];   // every `x.f(…)` where x is a plain identifier

  walk(ast, (node) => {
    const name = calleeName(node);
    if (!name) return;
    const obj = node.callee.object;

    if (name === 'getConnection') {
      connections.push({ node, varName: assignedTo(node, parents) });
      return;
    }

    const on = refPath(obj);
    if (name === 'prepareStatement' || name === 'prepareCall') {
      creations.push({
        node,
        kind: name === 'prepareCall' ? 'call' : 'statement',
        connVar: on,
        stmtVar: assignedTo(node, parents),
        sqlArg: node.arguments[0],
      });
    }
    if (on) memberCalls.push({ node, on, method: name });
  });

  creations.sort((a, b) => a.node.start - b.node.start);
  memberCalls.sort((a, b) => a.node.start - b.node.start);

  const chains = creations.map((c) => buildChain(c, { source, ast, parents, creations, memberCalls, procs, schema, holeKinds }));
  return { chains, connections };
}

function buildChain(create, ctx) {
  const { source, ast, parents, creations, memberCalls, procs, schema, holeKinds } = ctx;
  const gaps = [];
  const scope = enclosingFunction(create.node, parents) || ast;

  // This chain owns the statement handle until the handle is prepared again.
  const nextSameVar = creations.find(
    (o) => o.node.start > create.node.start && o.stmtVar === create.stmtVar && within(o.node, scope),
  );
  const until = nextSameVar ? nextSameVar.node.start : scope.end;
  const owns = (m) => m.node.start > create.node.start && m.node.start < until && within(m.node, scope);

  /* ---- SQL ---- */
  let sql = { text: '', static: false, reason: 'no argument' };
  if (create.sqlArg) {
    sql = resolveSql(create.sqlArg, source, scope, create.node.start);
  } else {
    gaps.push({
      code: 'SQL_MISSING',
      message: `${create.kind === 'call' ? 'prepareCall' : 'prepareStatement'} was called with no argument.`,
    });
  }
  // Most "dynamic" SQL is not dynamic in the way the name suggests. 605 of the
  // corpus's 767 concatenations interpolate a *table or column name* — inside
  // double quotes, where SQL has never allowed a bind parameter — so no amount
  // of parameterising would convert them. The conversion is an interpolation,
  // and it is deterministic. What it is not is safe: whether the interpolated
  // value can reach a caller is a judgement about the whole application, so
  // every one gets a finding naming the expression.
  const holeBinds = [];
  if (create.sqlArg && !sql.static && sql.template) {
    const t = sql.template;
    // A bare hole in DDL is an identifier too — `GRANT <role> TO <user>` has no
    // quotes and no bind parameters either.
    const isDDL = /^\s*(ALTER|CREATE|DROP|GRANT|REVOKE|RENAME)\b/i.test(t.sql);
    const plan = planHoles(t, isDDL, source, holeKinds?.get(create.node.start) || null);
    if (plan) {
      sql = { ...sql, text: plan.sql, static: true, interpolated: plan.interpolated, byModel: plan.byModel };
      holeBinds.push(...plan.binds);
      gaps.push(...plan.notes);
    }
  }

  if (create.sqlArg && !sql.static) {
    gaps.push({
      code: 'SQL_DYNAMIC',
      message:
        `The SQL is built at run time (${sql.reason || 'expression'})` +
        `${sql.via ? ` via \`${sql.via}\`` : ''}, so its columns and parameter count cannot be read here.`,
      fix: 'Convert this statement by hand, or make the SQL a static string with ? parameters.',
    });
  }

  if (!create.stmtVar) {
    gaps.push({
      code: 'STATEMENT_UNNAMED',
      message: 'The prepared statement is not assigned to a variable, so its binds and execution cannot be followed.',
    });
  }

  /* ---- Execution ---- */
  const execs = create.stmtVar
    ? memberCalls.filter((m) => m.on === create.stmtVar && EXECUTORS.has(m.method) && owns(m))
    : [];
  const exec = execs[0] || null;
  if (!exec) gaps.push({ code: 'NO_EXEC', message: 'The statement is prepared but never executed.' });
  if (execs.length > 1) {
    gaps.push({ code: 'MULTI_EXEC', message: `The statement is executed ${execs.length} times; only the first is analysed.` });
  }

  /* ---- Binds ----
   *
   * The loop question is not "were the binds set inside a loop" — hoisting the
   * prepare out of the loop is standard JDBC and by far the most common shape in
   * the corpus (22 sites, 374 binds). What matters is where the *execute* sits:
   *
   *   prepare; for (…) { set…; execute(); }   one round trip per iteration —
   *                                           keep the loop, one cds.run inside
   *   prepare; for (…) { set…; }  execute();  values accumulated across
   *                                           iterations, a real batch
   *
   * Only the second cannot be written as a single cds.run.
   */
  const sets = create.stmtVar
    ? memberCalls.filter((m) => m.on === create.stmtVar && SETTERS.has(m.method) && owns(m))
    : [];
  const execLoop = exec ? enclosingLoop(exec.node, parents) : null;
  let perIteration = false;
  const binds = [];
  for (const s of sets) {
    const [idxArg, valArg] = s.node.arguments;
    const index = idxArg && idxArg.type === 'Literal' && typeof idxArg.value === 'number' ? idxArg.value : null;
    if (index === null) {
      gaps.push({
        code: 'BIND_INDEX_DYNAMIC',
        message: `\`${s.method}\` is called with a computed parameter index; the bind order cannot be established.`,
      });
      continue;
    }
    const setLoop = enclosingLoop(s.node, parents);
    if (setLoop) {
      if (setLoop === execLoop) perIteration = true;
      else if (!execLoop || !within(setLoop, execLoop)) {
        gaps.push({
          code: 'BIND_BATCHED',
          message: `\`${s.method}(${index}, …)\` runs in a loop but the statement executes outside it — the values are accumulated across iterations.`,
          fix: 'CAP expresses a batch as one cds.run with an array of bind arrays. Convert this statement by hand.',
        });
      }
    }
    binds.push({
      index,
      setter: s.method,
      isNull: s.method === 'setNull',
      // `valueText` is the NEO source as written — right for a FACTS block or a
      // report. The emitter renders from `valueNode` instead, because a bind can
      // read a *different* statement's result set and that read gets rewritten.
      valueText: valArg ? source.slice(valArg.start, valArg.end) : 'null',
      valueNode: valArg || null,
      node: s.node,
    });
  }
  binds.sort((a, b) => a.index - b.index || a.node.start - b.node.start);

  const folded = foldConditionalBinds(binds, create.stmtVar, source, parents);
  binds.length = 0;
  binds.push(...folded.binds);

  // Whatever the fold could not turn into one expression, the branch itself can
  // still choose — see spillConditionalBinds.
  const statementOfNode = (node) => {
    for (let n = node; n; n = parents.get(n)) {
      if (n.type === 'ExpressionStatement' || n.type === 'VariableDeclaration') return n;
      if (n.type === 'BlockStatement' || /Function/.test(n.type)) return null;
    }
    return null;
  };
  const spilledResult = spillConditionalBinds(binds, exec, parents, statementOfNode);
  binds.length = 0;
  binds.push(...spilledResult.binds);

  // An index still bound more than once is a value chosen by a branch we could
  // not safely collapse.
  const byIndex = new Map();
  for (const b of binds) byIndex.set(b.index, (byIndex.get(b.index) || 0) + 1);
  for (const [index, n] of byIndex) {
    if (n > 1) {
      gaps.push({
        code: 'BIND_CONDITIONAL',
        message: `Parameter ${index} is bound ${n} times on different branches, so its value depends on a condition.`,
        fix: 'Fold the branches into one expression (a ternary) so the parameter is bound once, then re-run.',
      });
    }
  }

  let indices = [...byIndex.keys()].sort((a, b) => a - b);
  const missing = indices.map((v, i) => (v === i + 1 ? null : i + 1)).filter(Boolean);
  if (missing.length) {
    gaps.push({
      code: 'BIND_GAP',
      message: `Parameter indices are not a contiguous 1..${indices.length} run (missing ${missing.join(', ')}).`,
    });
  }

  // A value lifted out of the SQL text takes a `?` position of its own, so the
  // setters' indices shift: the n-th `setString` still fills the n-th `?` that
  // was written by hand, which is no longer the n-th `?` in the statement.
  // Both orders are known from the text, so the merge is arithmetic.
  if (holeBinds.length) {
    const fromHole = new Set(holeBinds.map((b) => b.index));
    const total = (maskSql(sql.text).match(/\?/g) || []).length;
    const shifted = new Map();
    let written = 0;
    for (let p = 1; p <= total; p++) if (!fromHole.has(p)) shifted.set(++written, p);
    for (const b of binds) b.index = shifted.get(b.index) ?? b.index;
    binds.push(...holeBinds);
    binds.sort((a, b) => a.index - b.index);
    indices = binds.map((b) => b.index);
  }

  const kind = sql.static ? statementKind(sql.text) : 'unknown';
  const returnsRows = kind === 'select' || (exec && exec.method === 'executeQuery');

  /* ---- Result set ---- */
  let resultVar = exec ? assignedTo(exec.node, parents) : null;
  if (!resultVar && create.stmtVar) {
    const grs = memberCalls.find((m) => m.on === create.stmtVar && m.method === 'getResultSet' && owns(m));
    if (grs) {
      resultVar = assignedTo(grs.node, parents);
      // `execute()` then `getResultSet()` splits the call from its rows across
      // two statements, so the rewrite would have to move the cds.run onto the
      // second one. One statement in each corpus does this; until that is worth
      // building, refusing beats converting it half-way.
      gaps.push({
        code: 'DEFERRED_RESULT_SET',
        message: 'The rows are taken from a separate `getResultSet()` call rather than from the execute itself.',
        fix: 'Assign the query result directly (`rs = pstmt.executeQuery()`), then re-run.',
      });
    }
  }
  if (returnsRows && exec && !resultVar) {
    gaps.push({
      code: 'RESULT_UNNAMED',
      message: 'The result set is not assigned to a variable, so the columns read from it cannot be followed.',
    });
  }

  const after = exec ? exec.node.start : create.node.start;
  const rsUntil = resultVar ? nextAssignment(resultVar, scope, after) : 0;
  const rsCalls = resultVar
    ? memberCalls.filter((m) => m.on === resultVar && m.node.start > after && m.node.start < rsUntil && within(m.node, scope))
    : [];
  const nexts = rsCalls.filter((m) => m.method === 'next');
  const gets = rsCalls.filter((m) => GETTERS.has(m.method));

  // Anything else called on the result set is a JDBC API that a CAP array does
  // not have. `rs.getMetaData()` is the one in the corpus, and it survived the
  // rewrite silently — the conversion looked complete and the file would have
  // thrown at run time on the first row. Whitelist, never blacklist: an
  // unrecognised method is a refusal.
  const stray = rsCalls.filter((m) => !GETTERS.has(m.method) && !['next', 'close'].includes(m.method));
  for (const m of new Map(stray.map((m) => [m.method, m])).values()) {
    gaps.push({
      code: 'RESULTSET_METHOD_UNSUPPORTED',
      message: `\`${resultVar}.${m.method}()\` is a JDBC ResultSet method; CAP returns a plain array of rows, which has no such method.`,
      fix: 'Rewrite what this call was for against the array CAP returns, then re-run.',
    });
  }

  /* ---- Shape: while(next()) is a row loop, if(next()) is a single row ---- */
  let shape = 'none';
  if (nexts.length) {
    const p = parents.get(nexts[0].node);
    if (p && (p.type === 'WhileStatement' || p.type === 'DoWhileStatement') && p.test === nexts[0].node) shape = 'loop';
    else if (p && p.type === 'IfStatement' && p.test === nexts[0].node) shape = 'single';
    else shape = 'advance';
  }
  if (nexts.length > 1 && shape !== 'loop') {
    gaps.push({
      code: 'MULTI_NEXT',
      message: `\`next()\` is called ${nexts.length} times outside a loop; the row cursor is being stepped by hand.`,
    });
  }
  if (shape === 'advance') {
    gaps.push({
      code: 'CURSOR_STEPPED',
      message: '`next()` is called on its own rather than as a `while` or `if` condition, so there is no row loop to rewrite.',
      fix: 'CAP returns an array; rewrite this as a loop over it, or index into it directly.',
    });
  }
  if (shape === 'loop' && parents.get(nexts[0].node).type === 'DoWhileStatement') {
    gaps.push({
      code: 'DO_WHILE_CURSOR',
      message: 'The row loop is a `do…while`, which runs its body once before testing — that is not a `for…of` over the rows.',
    });
  }

  // The row variable only exists inside the loop or branch that `next()` guards.
  // A getter outside it would compile to an undefined name, so refuse instead.
  const rowScope =
    shape === 'loop' ? parents.get(nexts[0].node)?.body
    : shape === 'single' ? parents.get(nexts[0].node)?.consequent
    : null;
  //
  // One shape is not a restructuring problem, and it is all 47 of them (§26):
  //
  //   } catch (e) { createDBErrorLog(…, rs.getNString(1), …); }
  //
  // The handler logs the row it was working on. In NEO that read throws a
  // second error inside the catch as often as not — the cursor is rarely on a
  // row after a failure — so the log never gets written. In CAP the rows are an
  // array that is still there, and `rs?.[0]?.COL` says exactly what the code
  // meant. A read outside the loop that is NOT in a catch is a real
  // restructuring, and still refuses.
  const inCatch = (node) => {
    for (let n = node; n; n = parents.get(n)) if (n.type === 'CatchClause') return true;
    return false;
  };
  const strayReads = new Set();
  if (rowScope) {
    const outside = gets.filter((g) => !within(g.node, rowScope));
    const stray = outside.filter((g) => !inCatch(g.node));
    for (const g of outside) strayReads.add(g.node);
    if (stray.length) {
      gaps.push({
        code: 'READ_OUTSIDE_ROW',
        message: 'A column is read outside the block that `next()` guards, where the row no longer exists.',
        fix: 'Copy the value into a variable inside the loop, then use that variable outside it.',
      });
    } else if (outside.length) {
      gaps.push({
        code: 'READ_IN_CATCH',
        level: 'note',
        message:
          `${outside.length} column read(s) sit in a \`catch\` block, outside the rows loop. They read the first row ` +
          'of the result (`rs?.[0]?.COL`), which is undefined if the statement itself is what failed.',
        fix: 'Check that the error log wants the first row. If it wants the row the loop was on, copy that row into a variable inside the loop.',
      });
    }
  }

  /* ---- Columns ---- */
  const notes = [];
  let columns = null;
  if (sql.static && kind === 'select') {
    const named = aliasUnnamedColumns(sql.text);
    if (named && named.aliased.length) {
      sql = { ...sql, text: named.sql, aliased: named.aliased };
      notes.push({
        code: 'COLUMN_ALIASED',
        message:
          `Added ${named.aliased.length} alias(es) to the SELECT list so positional reads have names: ` +
          named.aliased.map((a) => `${a.expr} → ${a.name}`).join(', ') + '.',
      });
    }
    columns = named ? named.columns : selectColumns(sql.text);
  }
  const reads = gets.map((g) => {
    const a = g.node.arguments[0];
    const index = a && a.type === 'Literal' && typeof a.value === 'number' ? a.value : null;
    const byName = a && a.type === 'Literal' && typeof a.value === 'string' ? a.value.toUpperCase() : null;
    const column = byName || (index && columns ? columns[index - 1] ?? null : null);
    // `outsideRow` reads from the result array itself, not the loop variable.
    return { index, byName, getter: g.method, column, node: g.node, outsideRow: strayReads.has(g.node) };
  });

  if (gets.length && kind === 'select' && sql.static && !columns) {
    gaps.push({
      code: 'COLUMNS_UNKNOWN',
      message: 'The SELECT list could not be read, so positional getters cannot be given column names.',
    });
  }
  for (const r of reads) {
    if (r.column) continue;
    // `rs.getString(i)` inside a `for (i…)` loop. There is no column name to
    // resolve, and the emitter would have written `rsRow.null` — which parses,
    // which is exactly why this needs to be a gap and not a comment.
    if (!r.index && !r.byName) {
      gaps.push({
        code: 'COLUMN_INDEX_DYNAMIC',
        message: `\`${r.getter}(…)\` is called with a computed column index, so the column it reads has no name here.`,
        fix: 'CAP returns rows keyed by name; iterate `Object.values(row)` or name the columns, then re-run.',
      });
      continue;
    }
    if (!columns) continue;
    if (r.index && r.index > columns.length) {
      gaps.push({
        code: 'COLUMN_OUT_OF_RANGE',
        message: `\`${r.getter}(${r.index})\` reads past the end of a ${columns.length}-column SELECT list.`,
      });
    } else if (r.index) {
      gaps.push({
        code: 'COLUMN_UNNAMED',
        message: `Column ${r.index} of the SELECT list is \`*\` or an unaliased expression, so \`${r.getter}(${r.index})\` has no name to use.`,
        fix: 'Give the column an alias in the SQL (`… AS MYCOL`), then re-run.',
      });
    }
  }

  /* ---- CALL: the unbound placeholders are OUT parameters ----
   *
   * `CALL p(?,?,?,?,?)` with four binds is not a defect — the fifth is an OUT
   * parameter, read back afterwards with `cstmt.getInteger(5)`. 116 of the 117
   * statements this used to refuse are exactly that.
   *
   * The one thing the JavaScript cannot say is what the OUT parameter is
   * *called*, and CAP returns it by name. So the procedure's own signature is
   * consulted; without it the statement keeps its refusal rather than guessing.
   */
  const outParams = [];
  let outResolved = false;
  if (create.kind === 'call' && sql.static && exec) {
    const sig = lookupProcedure(procs, sql.text, schema);
    const holes = (maskSql(sql.text).match(/\?/g) || []).length;
    const outPos = sig ? sig.params.map((p, i) => (p.mode === 'IN' ? null : i + 1)).filter(Boolean) : [];
    const bound = new Set(indices);
    const unbound = sig ? sig.params.map((_, i) => i + 1).filter((i) => !bound.has(i)) : [];
    // Trailing only. A mid-signature OUT would leave the bind array's positions
    // disagreeing with the `?` they fill, and there is not one in either corpus.
    const trailing = outPos.length > 0 && outPos.every((p, i) => p === sig.params.length - outPos.length + 1 + i);
    const matches = outPos.length === unbound.length && outPos.every((v, i) => v === unbound[i]);

    if (sig && sig.params.length === holes && matches && trailing) {
      outResolved = true;
      for (const g of memberCalls) {
        if (g.on !== create.stmtVar || !GETTERS.has(g.method) || !owns(g) || g.node.start < exec.node.start) continue;
        const a = g.node.arguments[0];
        const index = a && a.type === 'Literal' && typeof a.value === 'number' ? a.value : null;
        const param = index ? sig.params[index - 1] : null;
        if (!param || param.mode === 'IN') {
          outResolved = false;
          gaps.push({
            code: 'CALL_OUT_UNKNOWN',
            message: `\`${g.method}(${index ?? '…'})\` reads position ${index ?? '?'} of ${sig.name}, which is not an OUT parameter.`,
          });
          continue;
        }
        outParams.push({ index, name: param.name, getter: g.method, node: g.node });
      }

      // The OUT values arrive as the result of the call, so there has to be
      // somewhere to put it: either the execute is already assigned, or it
      // stands alone as its own statement and can become a declaration.
      const execStmt = parents.get(exec.node);
      if (outParams.length && !resultVar) {
        if (execStmt?.type !== 'ExpressionStatement') {
          outResolved = false;
          gaps.push({
            code: 'CALL_OUT_NOT_ASSIGNABLE',
            message: 'The OUT parameters are read back, but the `execute()` is not a statement of its own, so there is nowhere to name its result.',
          });
        } else {
          // The name we introduce is a `const`, so it lives in the block the
          // execute sits in. A read from outside that block would compile and
          // then throw at run time — the same trap as READ_OUTSIDE_ROW.
          let block = null;
          for (let n = parents.get(execStmt); n; n = parents.get(n)) {
            if (n.type === 'BlockStatement' || n.type === 'Program' || /Function/.test(n.type)) { block = n; break; }
          }
          if (block && outParams.some((o) => !within(o.node, block))) {
            outResolved = false;
            gaps.push({
              code: 'CALL_OUT_OUTSIDE_SCOPE',
              message: 'An OUT parameter is read outside the block the `execute()` sits in, where the call result would not be in scope.',
              fix: 'Assign the execute to a variable declared in the outer scope, then re-run.',
            });
          }
        }
      }
    }
  }

  if (binds.length && sql.static && !outResolved) {
    const holes = (maskSql(sql.text).match(/\?/g) || []).length;
    if (holes !== indices.length) {
      gaps.push({
        code: 'BIND_COUNT_MISMATCH',
        message: `The SQL has ${holes} \`?\` placeholder(s) but ${indices.length} parameter(s) are bound.`,
      });
    }
  }

  return {
    kind,                 // select | call | update | other | unknown
    connVar: create.connVar,
    stmtVar: create.stmtVar,
    resultVar,
    sql,                  // { text, static, reason?, via? }
    binds,
    outParams,            // [{ index, name, getter, node }] — a CALL's OUT parameters, read by name
    columns,
    reads,
    shape,                // loop | single | advance | none
    perIteration,         // the statement executes once per iteration of a surrounding loop
    // A `note` gap does not block the conversion — it is something true about
    // the result that the reader has to know, not something we could not decide.
    resolved: !gaps.some((g) => g.level !== 'note'),
    gaps,
    notes,
    nodes: {
      create: create.node,
      sets: sets.map((s) => s.node),
      foldedIfs: [...folded.consumedIfs],
      exec: exec ? exec.node : null,
      nexts: nexts.map((n) => n.node),
      gets: gets.map((g) => g.node),
    },
  };
}
