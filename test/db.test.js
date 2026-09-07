import assert from 'node:assert/strict';
import { analyseDb, selectColumns, statementKind, aliasUnnamedColumns } from '../src/transform/db.js';
import { parse, applyEdits, walk } from '../src/transform/js.js';

const one = (src) => {
  const { chains } = analyseDb(src);
  assert.equal(chains.length, 1, `expected exactly one chain, got ${chains.length}`);
  return chains[0];
};
const codes = (c) => c.gaps.map((g) => g.code).sort();

/* ---------------- the substrate ---------------- */

test('XSJS parses: top-level return and the $ global are not syntax errors', () => {
  assert.doesNotThrow(() => parse('$.response.setBody("x"); return 1;'));
});

test('a parse failure names the line and says what to do about it', () => {
  assert.throws(() => parse('function ( {', { filename: 'Bad.xsjs' }), /Bad\.xsjs is not parseable JavaScript at line 1/);
});

test('edits are applied by offset, leaving every other byte alone', () => {
  assert.equal(applyEdits('abcdef', [{ start: 2, end: 4, text: 'XY' }]), 'abXYef');
  assert.equal(applyEdits('abcdef', []), 'abcdef');
});

test('overlapping edits are refused rather than silently resolved', () => {
  assert.throws(
    () => applyEdits('abcdef', [{ start: 1, end: 4, text: 'x' }, { start: 3, end: 5, text: 'y' }]),
    /Overlapping edits/,
  );
});

test('the walker can be stopped, so a subtree is skipped', () => {
  const ast = parse('function f() { g(); }');
  let calls = 0;
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration') return false;
    if (n.type === 'CallExpression') calls++;
  });
  assert.equal(calls, 0);
});

/* ---------------- reading SQL ---------------- */

test('statement kind is read past leading whitespace and parens', () => {
  assert.equal(statementKind('  SELECT 1 FROM DUMMY'), 'select');
  assert.equal(statementKind('CALL "P"(?)'), 'call');
  assert.equal(statementKind(' insert into T values (?)'), 'update');
  assert.equal(statementKind('TRUNCATE TABLE T'), 'other');
});

test('the SELECT list is read, with aliases and table qualifiers resolved', () => {
  assert.deepEqual(
    selectColumns('SELECT A, T.B, "c" , X AS Y, COUNT(*) N FROM T'),
    ['A', 'B', 'C', 'Y', 'N'],
  );
});

test('a subquery in the select list does not end the list early', () => {
  assert.deepEqual(
    selectColumns('SELECT A, (SELECT MAX(X) FROM U) AS M, B FROM T'),
    ['A', 'M', 'B'],
  );
});

test('a FROM inside a string literal does not end the list either', () => {
  assert.deepEqual(selectColumns("SELECT 'FROM T' AS LBL, B FROM T"), ['LBL', 'B']);
});

test('an unnamed column is reported as unnamed rather than guessed', () => {
  assert.deepEqual(selectColumns('SELECT COUNT(*), A FROM T'), [null, 'A']);
  assert.deepEqual(selectColumns('SELECT * FROM T'), [null]);
});

test('a SELECT with no FROM still yields its columns', () => {
  assert.deepEqual(selectColumns('SELECT SESSION_USER AS U'), ['U']);
});

/* ---------------- aliasing what has no name ---------------- */

test('unnamed expressions are given aliases in the SQL itself', () => {
  const r = aliasUnnamedColumns('SELECT COUNT(*), A FROM T');
  assert.equal(r.sql, 'SELECT COUNT(*) AS COL1, A FROM T');
  assert.deepEqual(r.columns, ['COL1', 'A']);
  assert.deepEqual(r.aliased, [{ index: 1, name: 'COL1', expr: 'COUNT(*)' }]);
});

test('a star is left alone — there is nothing to alias it to', () => {
  const r = aliasUnnamedColumns('SELECT * FROM T');
  assert.equal(r.sql, 'SELECT * FROM T');
  assert.deepEqual(r.aliased, []);
});

test('an alias never collides with a name the query already uses', () => {
  const r = aliasUnnamedColumns('SELECT X AS COL1, COUNT(*) FROM T');
  assert.deepEqual(r.columns, ['COL1', 'COL2']);
});

test('the alias lands before a trailing comment, not inside it', () => {
  const r = aliasUnnamedColumns('SELECT COUNT(*) -- how many\n, A FROM T');
  assert.match(r.sql, /COUNT\(\*\) AS COL1 -- how many/);
  assert.deepEqual(r.columns, ['COL1', 'A']);
});

/* ---------------- the canonical chain ---------------- */

const CANONICAL = `
function f() {
  var conn = $.db.getConnection();
  var q = 'SELECT ID, NAME FROM "S"."T" WHERE ID = ?';
  var pstmt = conn.prepareStatement(q);
  pstmt.setNString(1, input.id);
  var rs = pstmt.executeQuery();
  while (rs.next()) { out.push(rs.getNString(2)); }
}`;

test('the whole chain resolves: SQL from a variable, bind, columns, shape', () => {
  const c = one(CANONICAL);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
  assert.equal(c.kind, 'select');
  assert.equal(c.stmtVar, 'pstmt');
  assert.equal(c.resultVar, 'rs');
  assert.equal(c.sql.text, 'SELECT ID, NAME FROM "S"."T" WHERE ID = ?');
  assert.deepEqual(c.binds.map((b) => [b.index, b.valueText]), [[1, 'input.id']]);
  assert.deepEqual(c.columns, ['ID', 'NAME']);
  assert.equal(c.shape, 'loop');
});

test('a positional getter is resolved to its column name', () => {
  assert.deepEqual(one(CANONICAL).reads.map((r) => [r.index, r.column]), [[2, 'NAME']]);
});

test('if (rs.next()) is a single row, while (rs.next()) is a loop', () => {
  const single = CANONICAL.replace('while (rs.next())', 'if (rs.next())');
  assert.equal(one(single).shape, 'single');
});

test('SQL split across concatenated literals is folded into one string', () => {
  const c = one(`
    var q = 'SELECT A,' + ' B ' + 'FROM T';
    var p = conn.prepareStatement(q);
    var rs = p.executeQuery();
    if (rs.next()) { x = rs.getNString(1); }`);
  assert.equal(c.sql.text, 'SELECT A, B FROM T');
  assert.deepEqual(c.columns, ['A', 'B']);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
});

test('the last assignment before the prepare wins when a variable is reused', () => {
  const c = one(`
    var q = 'SELECT A FROM T';
    q = 'SELECT B FROM U';
    var p = conn.prepareStatement(q);
    var rs = p.executeQuery();
    if (rs.next()) { x = rs.getNString(1); }`);
  assert.deepEqual(c.columns, ['B']);
});

test('two statements on the same handle do not steal each other\'s binds', () => {
  const { chains } = analyseDb(`
    function f() {
      var p = conn.prepareStatement('CALL A(?)');
      p.setNString(1, 'a');
      p.execute();
      p = conn.prepareStatement('CALL B(?)');
      p.setNString(1, 'b');
      p.execute();
    }`);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.map((c) => c.binds.map((b) => b.valueText)), [["'a'"], ["'b'"]]);
});

test('a reused result variable does not let one query claim the next one\'s reads', () => {
  const { chains } = analyseDb(`
    function f() {
      var rs;
      var p1 = conn.prepareStatement('SELECT A FROM T');
      rs = p1.executeQuery();
      while (rs.next()) { x = rs.getNString(1); }
      var p2 = conn.prepareStatement('SELECT B, C FROM U');
      rs = p2.executeQuery();
      while (rs.next()) { y = rs.getNString(2); }
    }`);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains[0].reads.map((r) => r.index), [1]);
  assert.deepEqual(chains[1].reads.map((r) => [r.index, r.column]), [[2, 'C']]);
  assert.ok(chains.every((c) => c.resolved), JSON.stringify(chains.flatMap((c) => c.gaps)));
});

/* ---------------- what the loop actually means ---------------- */

test('prepare once, execute per iteration is not a batch', () => {
  const c = one(`
    function f() {
      var p = conn.prepareCall('CALL P(?)');
      for (var i = 0; i < a.length; i++) { p.setNString(1, a[i]); p.execute(); }
    }`);
  assert.equal(c.perIteration, true);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
});

test('binds in a loop with the execute outside it is a batch, and is refused', () => {
  const c = one(`
    function f() {
      var p = conn.prepareCall('CALL P(?)');
      for (var i = 0; i < a.length; i++) { p.setNString(1, a[i]); }
      p.execute();
    }`);
  assert.ok(codes(c).includes('BIND_BATCHED'));
});

/* ---------------- conditional binds ---------------- */

test('if/else on one parameter folds into a single conditional value', () => {
  const c = one(`
    function f() {
      var p = conn.prepareCall('CALL P(?)');
      if (typeof m === 'string') p.setNString(1, m);
      else p.setNull(1);
      p.execute();
    }`);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
  assert.deepEqual(c.binds.map((b) => b.valueText), ["typeof m === 'string' ? m : null"]);
  assert.equal(c.nodes.foldedIfs.length, 1);
});

test('a branch that also does something else keeps its branch and spills the value', () => {
  // Folding this into a ternary would drop `log(…)`. So the `if` stays and each
  // setter becomes an assignment — the last one to run before the execute wins,
  // which is what JDBC did.
  const c = one(`
    function f() {
      var p = conn.prepareCall('CALL P(?)');
      if (cond) { log('picked m'); p.setNString(1, m); }
      else p.setNull(1);
      p.execute();
    }`);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
  assert.equal(c.nodes.foldedIfs.length, 0, 'the if is kept, not consumed');
  assert.equal(c.binds.length, 1);
  assert.equal(c.binds[0].spill.sites.length, 2);
});

test('a bind in a loop the execute is not in is left to BIND_BATCHED, not spilled', () => {
  const c = one(`
    function f() {
      var p = conn.prepareCall('CALL P(?)');
      for (var i = 0; i < n; i++) { if (c) p.setNString(1, a); else p.setNString(1, b); }
      p.execute();
    }`);
  assert.ok(codes(c).includes('BIND_BATCHED'));
  assert.ok(!c.binds.some((b) => b.spill), 'values accumulate across iterations — not a choice');
});

/* ---------------- the honest gaps ---------------- */

test('SQL assembled from a run-time value is refused, not half-read', () => {
  const c = one(`var q = 'SELECT A FROM T WHERE X IN (' + list + ')';
                 var p = conn.prepareStatement(q); var rs = p.executeQuery();`);
  assert.equal(c.kind, 'unknown');
  assert.equal(c.columns, null);
  assert.ok(codes(c).includes('SQL_DYNAMIC'));
});

test('a getter reading past the end of the SELECT list is reported', () => {
  const c = one(`
    var p = conn.prepareStatement('SELECT A, B FROM T');
    var rs = p.executeQuery();
    while (rs.next()) { x = rs.getNString(14); }`);
  assert.ok(codes(c).includes('COLUMN_OUT_OF_RANGE'));
});

test('a star column has no name to offer and says so', () => {
  const c = one(`
    var p = conn.prepareStatement('SELECT * FROM T');
    var rs = p.executeQuery();
    while (rs.next()) { x = rs.getNString(1); }`);
  assert.ok(codes(c).includes('COLUMN_UNNAMED'));
});

test('a prepared statement that is never executed is reported', () => {
  assert.ok(codes(one(`var p = conn.prepareStatement('SELECT A FROM T');`)).includes('NO_EXEC'));
});

test('a bind count that disagrees with the placeholders is reported', () => {
  const c = one(`
    var p = conn.prepareCall('CALL P(?,?)');
    p.setNString(1, a);
    p.execute();`);
  assert.ok(codes(c).includes('BIND_COUNT_MISMATCH'));
});

test('aliasing the SQL is recorded as a note, not hidden', () => {
  const c = one(`
    var p = conn.prepareStatement('SELECT COUNT(*) FROM T');
    var rs = p.executeQuery();
    if (rs.next()) { n = rs.getInteger(1); }`);
  assert.equal(c.resolved, true, JSON.stringify(c.gaps));
  assert.deepEqual(c.columns, ['COL1']);
  assert.equal(c.notes[0].code, 'COLUMN_ALIASED');
  assert.match(c.sql.text, /COUNT\(\*\) AS COL1/);
});

/* ---------------- three ways a chain used to convert wrongly ---------------- */

test('`query += fragment` is not the statement — the SQL is assembled', () => {
  // This produced `cds.run("GROUP BY CS.CMGID")` in both corpora: the right-hand
  // side of a `+=` read as the whole statement. Confident and silently wrong.
  const c = one(`
    var q = 'SELECT A FROM T WHERE 1=1';
    if (x) { q += ' AND B = 2'; }
    q += ' GROUP BY A';
    var pstmt = conn.prepareStatement(q);
    var rs = pstmt.executeQuery();
    while (rs.next()) { use(rs.getNString(1)); }
  `);
  assert.ok(codes(c).includes('SQL_DYNAMIC'));
  assert.match(c.gaps.find((g) => g.code === 'SQL_DYNAMIC').message, /built up with `\+=`/);
});

test('a computed column index has no name, so it is a gap and not `row.null`', () => {
  const c = one(`
    var pstmt = conn.prepareStatement('SELECT * FROM T');
    var rs = pstmt.executeQuery();
    while (rs.next()) { for (var i = 1; i <= n; i++) { use(rs.getString(i)); } }
  `);
  assert.ok(codes(c).includes('COLUMN_INDEX_DYNAMIC'));
  assert.equal(c.resolved, false);
});

test('a JDBC ResultSet method CAP does not have blocks the conversion', () => {
  const c = one(`
    var pstmt = conn.prepareStatement('SELECT A FROM T');
    var rs = pstmt.executeQuery();
    var meta = rs.getMetaData();
    while (rs.next()) { use(rs.getNString(1)); }
  `);
  assert.ok(codes(c).includes('RESULTSET_METHOD_UNSUPPORTED'));
});
