/**
 * Emission — turn the chains `db.js` resolved into CAP code.
 *
 * All of the thinking happened in the analysis. This module renders, and its
 * only judgement is *where the bytes go*. It never re-derives a column name or
 * a bind order; if `db.js` did not resolve a chain, this leaves the NEO code
 * exactly as it found it under a `NEEDS HUMAN REVIEW` banner listing why.
 *
 *     conn  = $.db.getConnection();                  →  (gone)
 *     q     = 'SELECT A, B FROM T WHERE C = ?';      →  (gone, folded into the call)
 *     pstmt = conn.prepareStatement(q);              →  (gone)
 *     pstmt.setNString(1, x);                        →  (gone, folded into the binds)
 *     rs    = pstmt.executeQuery();                  →  rs = await cds.run(`…`, [x]);
 *     while (rs.next()) {                            →  for (const rsRow of rs) {
 *       out.push(rs.getNString(1));                  →    out.push(rsRow.A);
 *     }                                              →  }
 *
 * The edits are spliced into the original text by offset, so every comment,
 * blank line and indentation choice outside the JDBC statements survives. That
 * is what makes the output diffable against the NEO file it came from.
 */

import { parse, parentMap, walk, applyEdits, enclosingFunction } from './js.js';
import { analyseDb, HOLE, renderValueTree } from './db.js';
import { aiRepair } from '../ai/index.js';
import { stripSchemaQualifiers, replaceInCode } from '../parse/sqlscript.js';
import { flattenCallPath } from '../core/naming.js';
import { classifyAfterTable, afterTableEdits } from './aftertable.js';

/** Connection and cursor housekeeping CAP does for you. */
const CLEANUP_METHODS = new Set(['close', 'commit', 'rollback', 'setAutoCommit']);

const within = (node, outer) => node.start >= outer.start && node.end <= outer.end;

/* ──────────────────────────── source surgery ──────────────────────────── */

/** The nearest ancestor that is a statement we can delete whole. */
export function statementOf(node, parents) {
  for (let n = node; n; n = parents.get(n)) {
    if (n.type === 'ExpressionStatement' || n.type === 'VariableDeclaration') return n;
    if (n.type === 'BlockStatement' || /Function/.test(n.type)) return null;
  }
  return null;
}

/**
 * The range to remove for a whole statement: its leading indentation through the
 * newline that ends it, so deleting leaves no blank line behind. A statement
 * sharing its line with other code is removed on its own, without the newline.
 */
function statementRange(stmt, source) {
  let start = stmt.start;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--;
  const ownsLine = start === 0 || source[start - 1] === '\n';
  if (!ownsLine) return { start: stmt.start, end: stmt.end };

  let end = stmt.end;
  let i = end;
  while (source[i] === ' ' || source[i] === '\t' || source[i] === ';') i++;
  // A trailing `//` comment belongs to the statement being deleted.
  if (source[i] === '/' && source[i + 1] === '/') while (i < source.length && source[i] !== '\n') i++;
  if (source[i] === '\r') i++;
  if (source[i] === '\n') end = i + 1;
  return { start, end };
}

const BODY_HOLDERS = /^(While|DoWhile|For|ForIn|ForOf|Labeled|With)Statement$/;

/**
 * The edit that removes a statement, given where it sits.
 *
 * `if (conn) conn.close();` has no braces, so deleting the statement alone
 * leaves a dangling `if` — a syntax error. The guard exists only to protect the
 * call, so the whole `if` goes with it; where that is not safe (there is an
 * `else`, or it is a loop body) an empty statement takes its place.
 */
export function removalEdit(stmt, parents, source) {
  const p = parents.get(stmt);
  if (p && p.type === 'IfStatement' && p.consequent === stmt && !p.alternate) {
    return { ...statementRange(p, source), text: '' };
  }
  const isBranch = p && p.type === 'IfStatement' && (p.consequent === stmt || p.alternate === stmt);
  const isBody = p && BODY_HOLDERS.test(p.type) && p.body === stmt;
  if (isBranch || isBody) return { start: stmt.start, end: stmt.end, text: ';' };
  return { ...statementRange(stmt, source), text: '' };
}

/** The `// …` comment trailing a statement, which usually names the parameter. */
function trailingComment(stmt, source) {
  let i = stmt.end;
  while (source[i] === ' ' || source[i] === '\t' || source[i] === ';') i++;
  if (source[i] !== '/' || source[i + 1] !== '/') return null;
  let end = i;
  while (end < source.length && source[end] !== '\n') end++;
  return source.slice(i, end).trimEnd();
}

export const indentOf = (node, source) => {
  let s = node.start;
  while (s > 0 && source[s - 1] !== '\n') s--;
  return /^[ \t]*/.exec(source.slice(s, node.start))[0];
};

/* ──────────────────────────── SQL rendering ──────────────────────────── */

/**
 * The SQL as CAP should see it: schema qualifiers stripped, `SESSION_USER`
 * replaced, and a NEO repository call path flattened to its CF name.
 *
 * The same three rules the calculation-view emitter applies, so a procedure
 * called from a handler and the same procedure emitted to `db/src` agree on
 * its name.
 */
export function cfSql(sql, { schema, cfg = {} } = {}) {
  const notes = [];
  let out = sql;

  const strippable = cfg.schemas?.strippable ?? (schema ? [schema] : []);
  if (strippable.length) {
    const r = stripSchemaQualifiers(out, strippable);
    out = r.sql;
    if (r.stripped.length) notes.push(`stripped ${r.stripped.length} schema qualifier(s)`);
  }

  const su = replaceInCode(out, /\bSESSION_USER\b/g, cfg.generator?.sessionUserReplacement || "SESSION_CONTEXT('APPLICATIONUSER')");
  out = su.sql;
  if (su.count) notes.push(`replaced SESSION_USER (${su.count})`);

  // `CALL "S.PKG.Procedures::pName"(?)` is a NEO repository path. `CALL SYS.X(?)`
  // is a real schema-qualified system call and is left alone — the `::` is what
  // tells them apart.
  out = out.replace(/(\bCALL\s*)"([^"]*::[^"]*)"/gi, (_m, call, path) => {
    notes.push(`flattened call path ${path}`);
    return `${call.replace(/\s*$/, ' ')}${flattenCallPath(path)}`;
  });

  return { sql: out.trim(), notes };
}

/** A template literal holding `sql`, with nothing in it able to escape. */
const asTemplate = (sql) => '`' + sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

/** The bind array, one value per line with the NEO comment that named it. */
function renderBinds(binds, indent) {
  if (!binds.length) return null;
  const withComments = binds.filter((b) => b.comment).length;
  if (binds.length <= 2 && !withComments) return `[${binds.map((b) => b.valueText).join(', ')}]`;
  const inner = binds
    .map((b) => `${indent}  ${b.valueText},${b.comment ? `  ${b.comment}` : ''}`)
    .join('\n');
  return `[\n${inner}\n${indent}]`;
}

/* ──────────────────────────── per-chain edits ──────────────────────────── */

function chainEdits(chain, ctx) {
  const { source, parents, opts, render } = ctx;
  // The payload in and the answer out are the same JDBC chains as any other,
  // but CAP has no table for them to go through — see transform/aftertable.js.
  if (chain.afterTable) return afterTableEdits(chain, ctx);
  const edits = [];
  const notes = [];
  const { nodes } = chain;

  const { sql, notes: sqlNotes } = cfSql(chain.sql.text, opts);
  notes.push(...sqlNotes);

  const execStmt = nodes.exec ? statementOf(nodes.exec, parents) : null;
  const indent = indentOf(execStmt || nodes.create, source);

  // A statement only Tier 2 could settle says so **in the file**. The CLI report
  // is not there when someone reads the code six months from now, and "a model
  // decided this" is the single most important thing for that reader to know.
  if (chain.sql.byModel) {
    const stmt = statementOf(chain.nodes.create, parents) || execStmt;
    if (stmt) {
      edits.push({
        start: stmt.start - indentOf(stmt, source).length,
        end: stmt.start - indentOf(stmt, source).length,
        text:
          `${indent}// AI-CLASSIFIED — a model decided how the value(s) spliced into this SQL
` +
          `${indent}//   are treated (a value to bind, a list, or an identifier). Everything
` +
          `${indent}//   else here is deterministic. Check it against the NEO original.
`,
      });
    }
  }

  // Binds carry the trailing comment of the setter they came from — in this
  // corpus that comment is nearly always the column name, which is exactly what
  // a reader of the generated array wants and cannot otherwise recover.
  const binds = chain.binds.map((b) => {
    const stmt = statementOf(b.node, parents);
    const text = b.spill ? b.spillVar
      : b.tree ? renderValueTree(b.tree, render)
      : render(b.valueNode) ?? 'null';
    return { ...b, valueText: text, comment: stmt && !b.conditional && !b.fromHole ? trailingComment(stmt, source) : null };
  });

  // An interpolated identifier goes back in as `${…}` — after escaping, so that
  // a `${` in the original SQL text is still escaped and only ours survives.
  let sqlText = asTemplate(sql);
  for (const [i, hole] of (chain.sql.interpolated || []).entries()) {
    sqlText = sqlText.replace(HOLE(i), '${' + render(hole.node) + '}');
  }

  const args = [sqlText, renderBinds(binds, indent)].filter(Boolean);
  const call = `await cds.run(${args.join(', ')})`;

  // 1. The execute becomes the call, in place — so whatever it was assigned to
  //    stays assigned, and the surrounding statement is untouched. A bare
  //    `cstmt.execute();` whose OUT parameters are read afterwards is the one
  //    case that needs a name, so it becomes a declaration.
  const needsDecl = chain.outVar && chain.outVar !== chain.resultVar;
  edits.push({
    start: nodes.exec.start,
    end: nodes.exec.end,
    text: needsDecl ? `const ${chain.outVar} = ${call}` : call,
  });

  // 2. Everything that only existed to feed it goes.
  const drop = (node) => {
    const stmt = statementOf(node, parents);
    if (stmt) edits.push(removalEdit(stmt, parents, source));
  };
  drop(nodes.create);
  for (const ifNode of nodes.foldedIfs) edits.push(removalEdit(ifNode, parents, source));
  // A spilled parameter keeps its setters — they become assignments — so the
  // branch they sit in, and whatever else it does, survives untouched.
  const spillSites = new Set(chain.binds.flatMap((b) => (b.spill ? b.spill.sites.map((x) => x.node) : [])));
  for (const set of nodes.sets) {
    if (nodes.foldedIfs.some((f) => within(set, f))) continue;   // the whole `if` already goes
    if (spillSites.has(set)) continue;
    drop(set);
  }

  for (const b of chain.binds) {
    if (!b.spill) continue;
    const anchorIndent = indentOf(b.spill.anchor, source);
    edits.push({
      start: b.spill.anchor.start,
      end: b.spill.anchor.start,
      text: `let ${b.spillVar};
${anchorIndent}`,
    });
    // Bracket the value rather than replacing the call: the value stays where it
    // is, so a rewrite another pass makes *inside* it — a column read that
    // becomes `rsRow.DRAFT` — still lands, instead of overlapping with a copy of
    // itself. Its comments and spacing survive too.
    for (const site of b.spill.sites) {
      if (!site.valueNode) {
        edits.push({ start: site.node.start, end: site.node.end, text: `${b.spillVar} = null` });
        continue;
      }
      edits.push({ start: site.node.start, end: site.valueNode.start, text: `${b.spillVar} = ` });
      edits.push({ start: site.valueNode.end, end: site.node.end, text: '' });
    }
  }

  // 3. The variable that held the SQL, if nothing else reads it. Only a plain
  //    variable — proving an object property is unread would need escape
  //    analysis, so those assignments stay put.
  if (ctx.sqlAssignIsDead(chain)) drop(chain.sql.assign);

  // 4. The cursor becomes an array, so the row walk becomes a loop over it.
  //    The reads themselves were computed in the first pass — see rowRewrites.
  const rows = chain.resultVar;
  if (chain.shape === 'loop') {
    const loop = parents.get(nodes.nexts[0]);
    edits.push({ start: loop.start, end: loop.body.start, text: `for (const ${chain.rowVar} of ${rows}) ` });
  } else if (chain.shape === 'single') {
    edits.push({ start: nodes.nexts[0].start, end: nodes.nexts[0].end, text: `${rows}.length` });
  }

  return { edits, notes };
}

/**
 * Every `getX(n)` rewrite in the file, for all resolved chains at once.
 *
 * These have to exist before anything is rendered, because a bind value can read
 * *another* statement's result set — `pstmt2.setNString(1, rs.getNString(1))` —
 * and that setter is about to be deleted and folded into a bind array. The value
 * moving into the array must carry the rewrite with it.
 */
function rowRewrites(chains, nameTaken) {
  const edits = [];
  for (const chain of chains) {
    if (!chain.resolved) continue;
    // The payload row is the request, so its columns are read off `req.data`
    // and there is no result set to name a loop variable for.
    if (chain.afterTable?.kind === 'read') {
      for (const r of chain.reads) {
        edits.push({ start: r.node.start, end: r.node.end, text: `${chain.afterTable.requestVar}.data.${r.column ?? chain.afterTable.column}` });
      }
      continue;
    }
    // A result set can be held on an object (`param.rs`), which is a fine
    // expression but not a name — the loop variable takes just its last segment.
    if (chain.shape === 'loop') chain.rowVar = nameTaken(`${chain.resultVar.split('.').pop()}Row`);

    // A parameter whose value a branch chooses needs a name for that value.
    for (const b of chain.binds) {
      if (b.spill) b.spillVar = nameTaken(`bind${b.index}`);
    }

    // A CALL's OUT parameters come back on the result object, by name:
    // `cstmt.getInteger(5)` → `callResult.OPK_BDSID`.
    if (chain.outParams?.length) {
      chain.outVar = chain.resultVar || nameTaken('callResult');
      for (const o of chain.outParams) {
        edits.push({ start: o.node.start, end: o.node.end, text: `${chain.outVar}.${o.name}` });
      }
    }

    const rowExpr =
      chain.shape === 'loop' ? chain.rowVar
      : chain.shape === 'single' ? `${chain.resultVar}[0]`
      : null;
    if (!rowExpr) continue;
    for (const r of chain.reads) {
      // A read in a catch block has no loop variable to use, and the statement
      // it was reading may be the one that threw — so it goes through the
      // result array, optionally.
      const expr = r.outsideRow ? `${chain.resultVar}?.[0]?` : rowExpr;
      edits.push({ start: r.node.start, end: r.node.end, text: `${expr}.${r.column}` });
    }
  }
  return edits;
}

/* ──────────────────────────── async propagation ──────────────────────────── */

const isFunction = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/**
 * `await` makes its enclosing function `async`, and that makes every caller of
 * it need an `await` too — which makes *them* async. Propagated over the file's
 * call graph until it settles.
 *
 * This is *derived*, not guessed, which matters: the strategy notes that missing
 * awaits are what the hand migration most often got wrong, and a missing await
 * fails silently at run time rather than loudly at build time.
 *
 * Only calls to functions declared in this file can be resolved here. Functions
 * that become async and are reachable from outside are returned by name so the
 * caller can see what changed across file boundaries.
 */
export function propagateAsync(ast, parents, awaitedNodes, source, isDeleted) {
  const enclosing = (node) => {
    for (let n = parents.get(node); n; n = parents.get(n)) if (isFunction(n)) return n;
    return null;
  };

  const asyncFns = new Set();
  for (const node of awaitedNodes) {
    const fn = enclosing(node);
    if (fn) asyncFns.add(fn);
  }

  // Named functions declared in this file, so a call site can be resolved.
  const declared = new Map();
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) declared.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFunction(n.init)) {
      declared.set(n.id.name, n.init);
    }
  });

  const callSites = [];
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier') return;
    const target = declared.get(n.callee.name);
    if (target) callSites.push({ node: n, target });
  });

  const awaitAt = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { node, target } of callSites) {
      if (!asyncFns.has(target) || awaitAt.has(node)) continue;
      awaitAt.add(node);
      changed = true;
      const fn = enclosing(node);
      if (fn && !asyncFns.has(fn)) asyncFns.add(fn);
    }
  }

  const edits = [];
  for (const fn of asyncFns) {
    if (isDeleted(fn.start)) continue;
    edits.push({ start: fn.start, end: fn.start, text: 'async ' });
  }
  for (const node of awaitAt) {
    // A call inside a statement we removed does not need anything.
    if (isDeleted(node.start)) continue;
    // `await` binds tighter than most operators but the call keeps its own
    // parentheses, so inserting in front of the callee is always safe here.
    edits.push({ start: node.start, end: node.start, text: 'await ' });
  }

  const names = [...asyncFns]
    .map((fn) => (fn.id ? fn.id.name : [...declared].find(([, v]) => v === fn)?.[0]))
    .filter(Boolean)
    .sort();

  return { edits, names };
}
/* ──────────────────────────── the database pass ──────────────────────────── */

/**
 * Every edit the database tier wants, given a shared file context.
 *
 * This returns edits rather than text so it can be composed with the other
 * transforms over one parse — and so `applyEdits` sees all of them at once and
 * can still refuse an overlap between two different transforms.
 *
 * @param {{source:string, ast:object, parents:Map, opts:object, nameTaken:Function}} ctx
 */
export function dbEdits(ctx) {
  const { source, ast, parents, opts, nameTaken } = ctx;
  const first = analyseDb(source, {
    filename: opts.filename, program: ast, procs: opts.procs, schema: opts.schema,
  });
  const { connections } = first;

  // Tier 2, and only over what Tier 1 refused. The answers go back *into*
  // analyseDb, so everything below this line is the same deterministic code
  // whether a model was consulted or not — see src/ai/index.js.
  const ai = opts.ai ? aiRepair(first.chains, ctx, opts.ai) : null;
  const chains = ai ? ai.chains : first.chains;

  // The after-table idiom is recognised before anything is rendered: it changes
  // what a column read becomes, and those are settled for the whole file at once.
  classifyAfterTable(chains, { ast, parents, statementOf });

  /**
   * Is the SQL variable's assignment dead, now that its value has moved into
   * the `cds.run` call?
   *
   * `readElsewhere` asks about the *name*, and in this corpus one `query`
   * variable serves every statement in a function — so it always answered yes,
   * and 1,046 assignments stayed behind on the ADC corpus alone: SQL that is
   * built, still naming the schema this migration exists to remove, and never
   * executed. This asks about the *assignment* instead.
   *
   * Sound rather than clever. It only answers yes when both statements sit in
   * one statement list with no loop around them — so source order is execution
   * order — and then only when nothing mentions the name between them, nothing
   * mentions it inside the consuming statement other than the call itself,
   * nothing mentions it after them before a plain reassignment, and no nested
   * function mentions it at all. Anything less obvious keeps its assignment.
   */
  const sqlAssignIsDead = (chain) => {
    const { assign, varName } = chain.sql;
    if (!assign || !varName || varName.includes('.')) return false;
    const stmt = statementOf(assign, parents);
    const createStmt = statementOf(chain.nodes.create, parents);
    if (!stmt || !createStmt) return false;
    // `var query = '…', rows = [];` — deleting the statement would take `rows`.
    if (stmt.type === 'VariableDeclaration' && stmt.declarations.length !== 1) return false;

    const holder = parents.get(stmt);
    const list = holder && (holder.type === 'SwitchCase' ? holder.consequent : holder.body);
    if (!Array.isArray(list)) return false;
    const i = list.indexOf(stmt);
    if (i < 0) return false;
    let j = -1;
    for (let k = i + 1; k < list.length; k++) if (within(createStmt, list[k])) { j = k; break; }
    if (j < 0) return false;

    /**
     * Is the name *read* here? Only a read can observe the value this
     * assignment put there — a declaration or another plain assignment to it
     * cannot, and both are everywhere in this corpus: one `var … query, pstmt …`
     * list at the top of the function, then a fresh `query = …` per statement.
     */
    const mentions = (node, except) => {
      let found = false;
      walk(node, (n) => {
        if (found || n.type !== 'Identifier' || n.name !== varName) return;
        if (except && within(n, except)) return;
        const p = parents.get(n);
        // A property name or an object key is not this binding at all.
        if (p && p.type === 'MemberExpression' && p.property === n && !p.computed) return;
        if (p && p.type === 'Property' && p.key === n && !p.computed) return;
        // Written, not read. `query += …` reads first, so it is not excluded.
        if (p && p.type === 'VariableDeclarator' && p.id === n) return;
        if (p && p.type === 'AssignmentExpression' && p.left === n && p.operator === '=') return;
        found = true;
      });
      return found;
    };
    /** `query = …;` on its own, so it certainly overwrites what came before. */
    const overwrites = (s) =>
      s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
      s.expression.operator === '=' && s.expression.left.type === 'Identifier' &&
      s.expression.left.name === varName;

    for (let k = i + 1; k < j; k++) if (mentions(list[k])) return false;
    if (mentions(list[j], chain.nodes.create)) return false;
    for (let k = j + 1; k < list.length; k++) {
      if (overwrites(list[k])) break;
      if (mentions(list[k])) return false;
    }

    // A loop around the pair makes "after" wrap back round to "before": a
    // statement ahead of the assignment reads the previous iteration's value.
    // Allowed only when nothing anywhere in that loop mentions the name outside
    // the window between the two statements.
    let loop = null;
    for (let n = holder; n && !/Function/.test(n.type); n = parents.get(n)) {
      if (/^(While|DoWhile|For|ForIn|ForOf)Statement$/.test(n.type)) loop = n;
    }
    if (loop && mentions(loop, { start: list[i].start, end: list[j].end })) return false;

    // A closure can read it at any time, so order proves nothing there.
    const fn = enclosingFunction(assign, parents);
    let captured = false;
    walk(fn ?? ast, (n) => {
      if (captured || n === fn || !isFunction(n)) return;
      if (mentions(n)) captured = true;
      return false;
    });
    return !captured;
  };

  // Pass 1: name the row variables and settle every column read in the file.
  const reads = rowRewrites(chains, nameTaken);

  /**
   * A node's source, with every rewrite that lands inside it already applied.
   *
   * A bind value is *moved* — out of its `setNString(1, …)` call and into the
   * array `cds.run` takes — and the statement it came from is then deleted. So
   * any edit another pass made inside it (a `$.request.parameters.get(…)`, an
   * aliased `$.import`) would be dropped with the statement unless it is
   * replayed into the copy here.
   */
  const rewrites = [...reads, ...(ctx.inlineRewrites || []).filter((e) => e.end > e.start)];
  const render = (node) => {
    if (!node) return null;
    const inner = rewrites
      .filter((e) => e.start >= node.start && e.end <= node.end)
      .map((e) => ({ start: e.start - node.start, end: e.end - node.start, text: e.text }));
    return applyEdits(source.slice(node.start, node.end), inner);
  };

  // Pass 2: everything else.
  const chainCtx = { source, parents, opts, render, sqlAssignIsDead, nameTaken, statementOf, removalEdit, indentOf };
  const edits = [...reads];
  const notes = [];
  let converted = 0;

  for (const chain of chains) {
    if (!chain.resolved) {
      // Left exactly as found, with the reasons directly above it.
      const stmt = statementOf(chain.nodes.create, parents);
      if (!stmt) continue;
      const indent = indentOf(stmt, source);
      const lines = [
        `${indent}// NEEDS HUMAN REVIEW — this database call was not converted.`,
        ...chain.gaps.flatMap((g) => [
          `${indent}//   ${g.code}: ${g.message}`,
          ...(g.fix ? [`${indent}//     ${g.fix}`] : []),
        ]),
      ];
      edits.push({ start: stmt.start - indent.length, end: stmt.start - indent.length, text: lines.join('\n') + '\n' });
      continue;
    }
    const r = chainEdits(chain, chainCtx);
    edits.push(...r.edits);
    notes.push(...r.notes);
    converted++;
  }

  // Connection housekeeping can only go once *every* statement in the file has
  // been converted — an unconverted one still needs the connection it opens.
  const allConverted = converted === chains.length && chains.length > 0;
  if (allConverted) {
    const connVars = new Set(connections.map((c) => c.varName).filter(Boolean));
    walk(ast, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
      if (!CLEANUP_METHODS.has(n.callee.property.name)) return;
      if (n.callee.object.type !== 'Identifier') return;
      const stmt = statementOf(n, parents);
      if (stmt) edits.push(removalEdit(stmt, parents, source));
    });
    for (const c of connections) {
      const stmt = statementOf(c.node, parents);
      if (stmt) edits.push(removalEdit(stmt, parents, source));
    }
    if (connVars.size) notes.push('removed connection handling — CAP owns the transaction');
  } else if (chains.length && converted) {
    notes.push('kept $.db.getConnection() and its close/commit calls: some statements in this file were not converted');
  }

  return {
    edits,
    notes,
    chains,
    proposals: ai ? ai.proposals : [],
    converted,
    skipped: chains.length - converted,
    awaitedNodes: chains.filter((c) => c.resolved && c.nodes.exec).map((c) => c.nodes.exec),
  };
}

/**
 * Two chains can legitimately ask for the same deletion — a `conn.close()` that
 * is also cleanup, say. Identical ranges collapse; genuinely conflicting ones
 * are left for `applyEdits` to reject.
 */
export function dedupe(edits) {
  const seen = new Set();
  return edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
