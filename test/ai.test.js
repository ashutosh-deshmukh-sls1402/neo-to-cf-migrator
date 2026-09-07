/**
 * Tier 2. Every test here uses an inline backend — a function — so the suite
 * never starts a subprocess and never depends on a model being installed.
 *
 * What is being tested is not "does the model answer well". It is the property
 * the design rests on: **a wrong answer cannot reach a file.**
 */

import assert from 'node:assert/strict';
import { transformFile } from '../src/transform/file.js';
import { resolveBackend } from '../src/ai/backend.js';

/** A backend that always gives the same answer, and counts the calls. */
const canned = (answer) => {
  const calls = [];
  const fn = (prompt) => { calls.push(prompt); return typeof answer === 'function' ? answer(prompt, calls.length) : answer; };
  fn.calls = calls;
  return fn;
};

// `LIMIT <hole>` — a bare hole, which quote parity cannot decide. Tier 1 refuses
// it; this is the case the AI tier exists for.
const BARE = `
function page(limit) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM T WHERE B = ? LIMIT ' + limit);
  pstmt.setNString(1, 'x');
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`;

const run = (src, ai) => transformFile(src, { filename: 'x.xsjs', kind: 'library', ai: ai ? resolveBackend(ai) : undefined });

test('with no backend the statement is refused, exactly as before', () => {
  const out = run(BARE);
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.match(out.text, /NEEDS HUMAN REVIEW/);
});

test('a `value` answer converts the statement, and the bind lands in ? order', () => {
  const ask = canned('{"holes":[{"index":0,"kind":"value"}]}');
  const out = run(BARE, ask);
  assert.ok(!out.findings.some((f) => f.code === 'SQL_DYNAMIC'), JSON.stringify(out.findings));
  // The hand-written ? is parameter 1 and the lifted value is parameter 2 —
  // the same arithmetic Tier 1 does for a hole it settled on its own.
  assert.ok(out.text.includes("WHERE B = ? LIMIT ?`, ['x', limit]"), out.text);
  assert.ok(out.findings.some((f) => f.code === 'AI_CONVERTED'));
  assert.equal(ask.calls.length, 1);
});

test('an `identifier` answer interpolates it, and says a model decided', () => {
  const out = run(BARE, canned('{"holes":[{"index":0,"kind":"identifier"}]}'));
  assert.ok(out.text.includes('LIMIT ${limit}'), out.text);
  const note = out.findings.find((f) => f.code === 'SQL_IDENTIFIER_INTERPOLATED');
  assert.ok(note && /AI tier/.test(note.message), JSON.stringify(note));
});

test('`unknown` is a real answer — nothing is converted and nothing is retried', () => {
  const ask = canned('{"holes":[{"index":0,"kind":"unknown"}]}');
  const out = run(BARE, ask);
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.ok(out.findings.some((f) => f.code === 'AI_DECLINED' && /unknown/.test(f.message)));
  assert.equal(ask.calls.length, 1);
});

test('a bind where SQL cannot take one is rejected, whatever the model says', () => {
  // `FROM <hole>` is a table name. A model answering `value` there is wrong in
  // a way the SQL grammar settles, so the validator refuses it — twice — and
  // the statement stays refused.
  const ask = canned('{"holes":[{"index":0,"kind":"value"}]}');
  const out = run(`
function all(t) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM ' + t);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`, ask);
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.ok(out.findings.some((f) => f.code === 'AI_DECLINED' && /bind parameter/.test(f.message)));
  assert.equal(ask.calls.length, 2, 'one retry, with the reason attached');
});

test('an unparseable answer is retried once, and a good second answer is taken', () => {
  const ask = canned((_p, n) => (n === 1 ? 'Sure! Here you go: not json at all' : '{"holes":[{"index":0,"kind":"value"}]}'));
  const out = run(BARE, ask);
  assert.equal(ask.calls.length, 2);
  assert.ok(out.findings.some((f) => f.code === 'AI_CONVERTED'));
  assert.match(ask.calls[1], /Your previous answer was rejected/);
});

test('a model that answers about holes that do not exist is rejected', () => {
  const out = run(BARE, canned('{"holes":[{"index":0,"kind":"value"},{"index":1,"kind":"value"}]}'));
  assert.ok(out.findings.some((f) => f.code === 'AI_DECLINED' && /the statement has 1/.test(f.message)));
});

test('a backend that throws leaves the tool exactly where it was', () => {
  const out = run(BARE, () => { throw new Error('claude: not found'); });
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.ok(out.findings.some((f) => f.code === 'AI_DECLINED' && /could not be reached/.test(f.message)));
  assert.match(out.text, /NEEDS HUMAN REVIEW/);
});

test('the model is never asked about a statement it could not unblock', () => {
  // Two blockers: the SQL is dynamic *and* the cursor is stepped by hand. The
  // ceiling rule (§22) says an answer to one of them converts nothing, so no
  // call is made.
  const ask = canned('{"holes":[{"index":0,"kind":"value"}]}');
  run(`
function one(limit) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM T LIMIT ' + limit);
  var rs = pstmt.executeQuery();
  rs.next();
  use(rs.getNString(1));
}
`, ask);
  assert.equal(ask.calls.length, 0);
});

test('a statement Tier 1 already converts is never sent to a model', () => {
  const ask = canned('{"holes":[]}');
  run(`
function ok(x) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM T WHERE B = ?');
  pstmt.setNString(1, x);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`, ask);
  assert.equal(ask.calls.length, 0);
});

test('the answer re-enters Tier 1, which can still refuse it', () => {
  // The model settles the SQL, and Tier 1 then finds what it could not see
  // before: `getNString(2)` reads past the end of a one-column SELECT. The
  // conversion is not emitted and the refusal is Tier 1's, not the model's.
  const out = run(`
function page(limit) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT A FROM T LIMIT ' + limit);
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(2)); }
}
`, canned('{"holes":[{"index":0,"kind":"value"}]}'));
  // The refusal the developer reads is the original one, and the note says what
  // Tier 1 found once the model's answer let it look.
  assert.ok(out.findings.some((f) => f.code === 'SQL_DYNAMIC'));
  assert.match(out.text, /NEEDS HUMAN REVIEW/);
  assert.ok(out.findings.some((f) => f.code === 'AI_DECLINED' && /Tier 1 still refused it: COLUMN_OUT_OF_RANGE/.test(f.message)));
});

test('JSON wrapped in a fence and a sentence is still read', () => {
  const out = run(BARE, canned('```json\n{"holes":[{"index":0,"kind":"value"}]}\n```\nHope that helps!'));
  assert.ok(out.findings.some((f) => f.code === 'AI_CONVERTED'));
});

test('resolveBackend', () => {
  assert.equal(resolveBackend(undefined), null);
  assert.equal(resolveBackend('none'), null);
  assert.equal(resolveBackend('claude').name, 'claude');
  assert.equal(resolveBackend('cmd:ollama run x').name, 'ollama run x');
  assert.throws(() => resolveBackend('gpt5'), /Unknown --ai backend/);
  assert.throws(() => resolveBackend('cmd:'), /needs a command/);
});

test('a statement only Tier 2 could settle says so in the file itself', () => {
  const out = run(BARE, canned('{"holes":[{"index":0,"kind":"value"}]}'));
  assert.match(out.text, /AI-CLASSIFIED — a model decided/);
});

test('a statement Tier 1 settled on its own carries no such marker', () => {
  const out = transformFile(`
function find(name) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement("SELECT A FROM T WHERE N = '" + name + "'");
  var rs = pstmt.executeQuery();
  while (rs.next()) { use(rs.getNString(1)); }
}
`, { filename: 'x.xsjs', ai: resolveBackend(canned('{"holes":[{"index":0,"kind":"identifier"}]}')) });
  assert.ok(!/AI-CLASSIFIED/.test(out.text), out.text);
  assert.ok(out.text.includes('WHERE N = ?'), out.text);
});
