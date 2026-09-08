import assert from 'node:assert/strict';
import { cfSql } from '../src/transform/emitdb.js';
import { transformFile } from '../src/transform/file.js';
import { parse } from '../src/transform/js.js';

const run = (src, opts = {}) => transformFile(src, { schema: 'S', ...opts });
/** Everything the emitter produces must be a loadable ES module. */
const parses = (text) => { parse(text, { sourceType: 'module' }); return true; };
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/* ---------------- SQL conventions ---------------- */

test('the schema qualifier is stripped, matching what db/src emits', () => {
  assert.equal(cfSql('SELECT A FROM "S"."T"', { schema: 'S' }).sql, 'SELECT A FROM "T"');
});

test('SESSION_USER is replaced — the CF connection is a technical user', () => {
  assert.match(cfSql('SELECT A FROM T WHERE U = SESSION_USER', {}).sql, /SESSION_CONTEXT\('APPLICATIONUSER'\)/);
});

test('a NEO repository call path is flattened to its CF procedure name', () => {
  assert.equal(
    cfSql('CALL"S.PKG.Procedures::prDoThing"(?)', {}).sql,
    'CALL S_PKG_Procedures_prDoThing(?)',
  );
});

test('a real schema-qualified system call is left alone — no :: means not a NEO path', () => {
  assert.equal(cfSql("CALL SYS.GET_OBJECT_DEFINITION('S', ?)", {}).sql, "CALL SYS.GET_OBJECT_DEFINITION('S', ?)");
});

/* ---------------- the three statement shapes ---------------- */

const LOOP = `function f() {
  var conn = $.db.getConnection();
  var q = 'SELECT ID, NAME FROM "S"."T" WHERE ID = ?';
  var pstmt = conn.prepareStatement(q);
  pstmt.setNString(1, input.id);
  var rs = pstmt.executeQuery();
  while (rs.next()) {
    out.push(rs.getNString(2));
  }
  conn.close();
}`;

test('a row loop becomes for…of over the rows, with named columns', () => {
  const r = run(LOOP);
  assert.equal(r.converted, 1);
  assert.ok(parses(r.text));
  assert.match(r.text, /rs = await cds\.run\(`SELECT ID, NAME FROM "T" WHERE ID = \?`, \[input\.id\]\)/);
  assert.match(r.text, /for \(const rsRow of rs\) \{/);
  assert.match(r.text, /out\.push\(rsRow\.NAME\)/);
});

test('the prepare, the binds, the SQL variable and the connection all go', () => {
  const r = run(LOOP);
  for (const gone of ['prepareStatement', 'setNString', 'executeQuery', 'getConnection', 'conn.close', "var q ="]) {
    assert.doesNotMatch(r.text, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${gone} should be gone`);
  }
});

test('a single-row read indexes the array instead of looping', () => {
  const r = run(LOOP.replace('while (rs.next())', 'if (rs.next())'));
  assert.ok(parses(r.text));
  assert.match(r.text, /if \(rs\.length\) \{/);
  assert.match(r.text, /out\.push\(rs\[0\]\.NAME\)/);
});

test('a CALL with no result set is just the run', () => {
  const r = run(`function f() {
    var p = conn.prepareCall('CALL "S.P::doIt"(?,?)');
    p.setNString(1, a);
    p.setNString(2, b);
    p.execute();
  }`);
  assert.ok(parses(r.text));
  assert.match(squash(r.text), /await cds\.run\(`CALL S_P_doIt\(\?,\?\)`, \[a, b\]\)/);
});

test('a loop that executes once per iteration keeps its loop', () => {
  const r = run(`function f() {
    var p = conn.prepareCall('CALL "S.P::doIt"(?)');
    for (var i = 0; i < rows.length; i++) {
      p.setNString(1, rows[i].ID);
      p.execute();
    }
  }`);
  assert.ok(parses(r.text));
  assert.match(r.text, /for \(let i = 0; i < rows\.length; i\+\+\) \{/);
  assert.match(r.text, /await cds\.run\(`CALL S_P_doIt\(\?\)`, \[rows\[i\]\.ID\]\)/);
});

/* ---------------- what the output keeps ---------------- */

test('comments and formatting outside the JDBC statements are untouched', () => {
  const r = run(`// a leading note
function f() {
  /* kept */
  var p = conn.prepareStatement('SELECT A FROM T');
  var rs = p.executeQuery();
  if (rs.next()) { x = rs.getNString(1); }   // trailing note
}`);
  assert.match(r.text, /^import cds from "@sap\/cds";\n\/\/ a leading note/);
  assert.match(r.text, /\/\* kept \*\//);
  assert.match(r.text, /\/\/ trailing note/);
});

test('the comment naming a parameter follows it into the bind array', () => {
  const r = run(`function f() {
    var p = conn.prepareCall('CALL "S.P::x"(?,?,?)');
    p.setNString(1, a);   // Employee ID
    p.setNString(2, b);   // Employee Name
    p.setNString(3, c);   // Status
    p.execute();
  }`);
  assert.match(r.text, /a,\s+\/\/ Employee ID/);
  assert.match(r.text, /c,\s+\/\/ Status/);
});

/* ---------------- refusals stay visible ---------------- */

test('an unresolved statement keeps its NEO code and says why above it', () => {
  const r = run(`function f() {
    var q = 'SELECT A FROM T WHERE X IN (' + list + ')';
    var p = conn.prepareStatement(q);
    var rs = p.executeQuery();
  }`);
  assert.equal(r.converted, 0);
  assert.equal(r.skipped, 1);
  assert.match(r.text, /NEEDS HUMAN REVIEW/);
  assert.match(r.text, /SQL_DYNAMIC/);
  assert.match(r.text, /const p = conn\.prepareStatement\(q\);/);   // untouched
  assert.doesNotMatch(r.text, /cds\.run/);
});

test('the connection stays when any statement in the file was refused', () => {
  const r = run(`function f() {
    var conn = $.db.getConnection();
    var p1 = conn.prepareStatement('SELECT A FROM T');
    var rs = p1.executeQuery();
    if (rs.next()) { x = rs.getNString(1); }
    var q = 'SELECT B FROM ' + t;
    var p2 = conn.prepareStatement(q);
    var rs2 = p2.executeQuery();
    conn.close();
  }`);
  assert.equal(r.converted, 1);
  assert.equal(r.skipped, 1);
  assert.match(r.text, /\$\.db\.getConnection/);
  assert.match(r.text, /conn\.close\(\)/);
  assert.ok(r.notes.some((n) => /kept \$\.db\.getConnection/.test(n)));
});

test('a brace-less guard around a close goes with it, leaving no dangling if', () => {
  const r = run(`function f() {
    var conn = $.db.getConnection();
    var p = conn.prepareStatement('SELECT A FROM T');
    var rs = p.executeQuery();
    if (rs.next()) { x = rs.getNString(1); }
    if (conn) conn.close();
  }`);
  assert.ok(parses(r.text), 'a dangling `if (conn)` would not parse');
  assert.doesNotMatch(r.text, /conn\.close/);
});

/* ---------------- async ---------------- */

test('await makes its function async, and that propagates to callers', () => {
  const r = run(`function read() {
    var p = conn.prepareStatement('SELECT A FROM T');
    var rs = p.executeQuery();
    if (rs.next()) { return rs.getNString(1); }
  }
  function outer() { return read(); }
  function outermost() { return outer(); }`);
  assert.ok(parses(r.text));
  assert.match(r.text, /async function read\(\)/);
  assert.match(r.text, /async function outer\(\) \{ return await read\(\); \}/);
  assert.match(r.text, /async function outermost\(\) \{ return await outer\(\); \}/);
  assert.deepEqual(r.asyncFunctions, ['outer', 'outermost', 'read']);
});

test('a function with no database call is left synchronous', () => {
  const r = run(`function pure() { return 1; }
  function read() {
    var p = conn.prepareStatement('SELECT A FROM T');
    p.executeQuery();
  }`);
  assert.doesNotMatch(r.text, /async function pure/);
});

/* ---------------- handles that are not plain variables ---------------- */

test('a connection reached through an object is tracked like any other', () => {
  const r = run(`function f(param) {
    var pstmt = param.connection.prepareStatement('SELECT A FROM "S"."T" WHERE B = ?');
    pstmt.setNString(1, x);
    var rs = pstmt.executeQuery();
    while (rs.next()) { out.push(rs.getNString(1)); }
  }`);
  assert.equal(r.converted, 1, JSON.stringify(r.chains[0].gaps));
  assert.ok(parses(r.text));
  assert.match(r.text, /rs = await cds\.run\(`SELECT A FROM "T" WHERE B = \?`, \[x\]\)/);
});

test('a result set held on an object still gets a usable loop variable', () => {
  const r = run(`function f(p) {
    var st = conn.prepareStatement('SELECT A FROM T');
    p.rs = st.executeQuery();
    while (p.rs.next()) { out.push(p.rs.getNString(1)); }
  }`);
  assert.ok(parses(r.text));
  assert.match(r.text, /for \(const rsRow of p\.rs\)/);
  assert.match(r.text, /out\.push\(rsRow\.A\)/);
});

/* ---------------- cross-statement reads ---------------- */

test('a bind reading another statement\'s row carries the rewrite into the array', () => {
  const r = run(`function f() {
    var p1 = conn.prepareStatement('SELECT NAME FROM T');
    var rs = p1.executeQuery();
    if (rs.next()) {
      var p2 = conn.prepareCall('CALL "S.P::x"(?)');
      p2.setNString(1, rs.getNString(1));
      p2.execute();
    }
  }`);
  assert.equal(r.converted, 2);
  assert.ok(parses(r.text));
  assert.match(r.text, /await cds\.run\(`CALL S_P_x\(\?\)`, \[rs\[0\]\.NAME\]\)/);
  assert.doesNotMatch(r.text, /getNString/);
});

/* ---------------- NEO defects the conversion exposes ---------------- */

test('a function declared twice is flagged where a module would reject it', () => {
  const r = run(`function dup() { return 1; }
  function other() {
    var p = conn.prepareStatement('SELECT A FROM T');
    p.executeQuery();
  }
  function dup() { return 2; }`);
  assert.deepEqual(r.duplicateFunctions, ['dup']);
  assert.match(r.text, /NEEDS HUMAN REVIEW — `dup` is already declared on line 1/);
});

test('a file with no database access is returned unchanged', () => {
  const src = 'function f() { return 1; }\n';
  const r = run(src);
  assert.equal(r.converted, 0);
  assert.equal(r.text, src);
});

/* ---------------- SQL that interpolates an identifier ---------------- */

test('a table name concatenated into the SQL is interpolated, not bound', () => {
  // SQL has never allowed a bind parameter in an identifier position, so this
  // is the only conversion there is — 605 of the corpus's 767 "dynamic"
  // statements are exactly this shape.
  const out = run(`
function read(param) {
  var after = param.afterTableName;
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT ID,PAYLOAD FROM "' + after + '"');
  var rs = pstmt.executeQuery();
  var o = [];
  while (rs.next()) { o.push({ ID: rs.getNString(1) }); }
  return o;
}
`);
  assert.match(out.text, /await cds\.run\(`SELECT ID,PAYLOAD FROM "\$\{after\}"`\)/);
  assert.ok(out.findings.some((f) => f.code === 'SQL_IDENTIFIER_INTERPOLATED'));
  assert.equal(out.skipped, 0);
});

test('the interpolation note names the expression and does not block the conversion', () => {
  const out = run(`
function read(t) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM "' + t + '"');
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  const note = out.findings.find((f) => f.code === 'SQL_IDENTIFIER_INTERPOLATED');
  assert.match(note.message, /`t`/);
  assert.match(note.fix, /caller-supplied/);
  assert.equal(out.converted, 1);
});

test('an interpolated identifier and a real bind coexist in one statement', () => {
  const out = run(`
function write(after, payload) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('UPDATE "' + after + '" SET PAYLOAD = ? ');
  pstmt.setNString(1, payload);
  pstmt.executeUpdate();
}
`);
  assert.match(out.text, /await cds\.run\(`UPDATE "\$\{after\}" SET PAYLOAD = \?`, \[payload\]\)/);
});

test('DDL takes no parameters at all, so its values interpolate too', () => {
  const out = run(`
function grant(role, user) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('GRANT ' + role + ' TO ' + user);
  pstmt.execute();
}
`);
  assert.match(out.text, /await cds\.run\(`GRANT \$\{role\} TO \$\{user\}`\)/);
  assert.equal(out.findings.filter((f) => f.code === 'SQL_IDENTIFIER_INTERPOLATED').length, 2);
});

test('a value spliced into a WHERE clause becomes a bind', () => {
  // Inside single quotes it is a value spanning the whole literal, so the
  // quotes go with it and it becomes a `?` — §26.
  const out = run(`
function find(name) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("SELECT A FROM T WHERE N = '" + name + "'");
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  assert.ok(!out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.ok(out.text.includes('`SELECT A FROM T WHERE N = ?`, [name]'), out.text);
});

test('a value hole takes its place in an existing bind order', () => {
  // The hand-written `?` is parameter 1 in NEO and parameter 2 in the output,
  // because the lifted value sits before it in the text.
  const out = run(`
function find(name, id) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("SELECT A FROM T WHERE N = '" + name + "' AND ID = ?");
  pstmt.setInteger(1, id);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  assert.ok(!out.findings.some((f) => f.code === 'SQL_DYNAMIC' || f.code === 'BIND_COUNT_MISMATCH'));
  assert.ok(out.text.includes('WHERE N = ? AND ID = ?`, [name, id]'), out.text);
});

test('a joined list stays interpolated — one ? cannot stand for a list', () => {
  const out = run(`
function find(ids) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("SELECT A FROM T WHERE ID IN ('" + ids.join("','") + "')");
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  assert.ok(out.findings.some((f) => f.code === 'SQL_VALUE_INTERPOLATED'));
  const want = "IN ('" + "$" + "{ids.join(" + JSON.stringify("','") + ")}')";
  assert.ok(out.text.includes(want), out.text);
});

test('DDL interpolates its values — it takes no bind parameters', () => {
  const out = run(`
function add(user) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("CREATE USER " + user + " WITH IDENTITY '" + user + "' FOR SAML PROVIDER P");
  pstmt.execute();
}
`);
  assert.ok(!out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.match(out.text, /CREATE USER \${user} WITH IDENTITY '\${user}'/);
});

test('a value that is only part of a literal is still refused', () => {
  const out = run(`
function find(name) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("SELECT A FROM T WHERE N LIKE '%" + name + "%'");
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
});

test('a bare value in a SELECT is not assumed to be an identifier', () => {
  const out = run(`
function page(limit) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM T LIMIT ' + limit);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
});

test('a column read in a catch block reads the first row, not the loop variable', () => {
  // The one shape READ_OUTSIDE_ROW was refusing, and all 47 of them (§26).
  const out = run(`
function load(id) {
  try {
    var conn = $.db.getConnection();
    var pstmt = conn.prepareStatement('SELECT PAYLOAD FROM T WHERE ID = ?');
    pstmt.setNString(1, id);
    var rs = pstmt.executeQuery();
    if (rs.next()) { use(rs.getNString(1)); }
  } catch (e) {
    log(rs.getNString(1), e);
  }
}
`);
  assert.ok(!out.findings.some((f) => f.code === 'READ_OUTSIDE_ROW'), JSON.stringify(out.findings));
  assert.ok(out.findings.some((f) => f.code === 'READ_IN_CATCH'));
  assert.ok(out.text.includes('log(rs?.[0]?.PAYLOAD, e)'), out.text);
  assert.ok(out.text.includes('use(rs[0].PAYLOAD)'), out.text);
});

test('a column read after the loop, outside any catch, is still refused', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT PAYLOAD FROM T WHERE ID = ?');
  pstmt.setNString(1, id);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
  after(rs.getNString(1));
}
`);
  assert.ok(out.findings.some((f) => f.code === 'READ_OUTSIDE_ROW'));
});

/* ---------------- the SQL string, once its value has moved ---------------- */

test('the SQL string assignment goes with the statement it fed', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query = 'SELECT A FROM "S"."T" WHERE ID = ?';
  var pstmt = conn.prepareStatement(query);
  pstmt.setNString(1, id);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`);
  // the whole point: no schema name is left standing in SQL nobody executes
  assert.ok(!out.text.includes('"S"."T"'), out.text);
  assert.ok(!/query\s*=/.test(out.text), out.text);
  assert.ok(parses(out.text));
});

test('one `query` variable reused by two statements loses both assignments', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query, pstmt, rs;
  query = 'SELECT A FROM "S"."T1"';
  pstmt = conn.prepareStatement(query);
  rs = pstmt.executeQuery();
  query = 'SELECT B FROM "S"."T2"';
  pstmt = conn.prepareStatement(query);
  rs = pstmt.executeQuery();
}
`);
  assert.ok(!out.text.includes('"S"."T1"'), out.text);
  assert.ok(!out.text.includes('"S"."T2"'), out.text);
});

test('an assignment whose value something else still reads is kept', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query = 'SELECT A FROM "S"."T"';
  var pstmt = conn.prepareStatement(query);
  var rs = pstmt.executeQuery();
  log(query);
}
`);
  assert.match(out.text, /query = 'SELECT A FROM "S"\."T"'/);
});

test('a read between the assignment and the prepare keeps it too', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query = 'SELECT A FROM "S"."T"';
  log(query);
  var pstmt = conn.prepareStatement(query);
  var rs = pstmt.executeQuery();
}
`);
  assert.match(out.text, /query = 'SELECT A FROM "S"\."T"'/);
});

test('a closure could read it at any time, so the assignment stays', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query = 'SELECT A FROM "S"."T"';
  var pstmt = conn.prepareStatement(query);
  var rs = pstmt.executeQuery();
  later(function () { log(query); });
}
`);
  assert.match(out.text, /query = 'SELECT A FROM "S"\."T"'/);
});

test('a declaration that also declares something else is never deleted', () => {
  const out = run(`
function load(id) {
  var conn = $.db.getConnection();
  var query = 'SELECT A FROM "S"."T"', rows = [];
  var pstmt = conn.prepareStatement(query);
  var rs = pstmt.executeQuery();
  while (rs.next()) { rows.push(rs.getNString(1)); }
  return rows;
}
`);
  assert.match(out.text, /rows = \[\]/);
  assert.ok(parses(out.text));
});

test('inside a loop the assignment still goes, as long as nothing else reads it', () => {
  const out = run(`
function load(ids) {
  var conn = $.db.getConnection();
  for (var i = 0; i < ids.length; i++) {
    var query = 'SELECT A FROM "S"."T" WHERE ID = ?';
    var pstmt = conn.prepareStatement(query);
    pstmt.setNString(1, ids[i]);
    var rs = pstmt.executeQuery();
  }
}
`);
  assert.ok(!out.text.includes('"S"."T"'), out.text);
});

test('a loop that reads the name ahead of the assignment keeps it', () => {
  const out = run(`
function load(ids) {
  var conn = $.db.getConnection();
  var query;
  for (var i = 0; i < ids.length; i++) {
    log(query);
    query = 'SELECT A FROM "S"."T" WHERE ID = ?';
    var pstmt = conn.prepareStatement(query);
    pstmt.setNString(1, ids[i]);
    var rs = pstmt.executeQuery();
  }
}
`);
  assert.match(out.text, /query = 'SELECT A FROM "S"\."T" WHERE ID = \?'/);
});
