import assert from 'node:assert/strict';
import { transformFile } from '../src/transform/file.js';

const run = (src) => transformFile(src, { filename: 'T.xsjslib', schema: 'S' });
const codes = (r) => r.findings.map((f) => f.code);

/** The corpus idiom, with whatever body and trailer the test needs. */
const handler = (body, trailer = '') => `
function H(param) {
	var after = param.afterTableName;
	var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '" ');
	var rs = pstmt.executeQuery();
	if (rs.next()) {
${body}
	}
${trailer}
}
`;

const WRITE_BACK = `
		pstmt = param.connection.prepareStatement('UPDATE "' + after + '" SET PAYLOAD = ? ');
		pstmt.setNString(1, JSON.stringify(out));
		pstmt.execute();`;

test('the payload read becomes req.data.<COLUMN>, and the after table is gone', () => {
  const r = run(handler('\t\tvar oIn = JSON.parse(rs.getNString(1));'));
  assert.match(r.text, /oIn = JSON\.parse\(param\.data\.PAYLOAD\)/);
  // no SELECT survives, and neither does the variable that named the table
  assert.doesNotMatch(r.text, /cds\.run/);
  assert.doesNotMatch(r.text, /afterTableName/);
  assert.ok(codes(r).includes('AFTER_TABLE_PAYLOAD'));
});

test('the `if (rs.next())` guard becomes a check that the caller sent the parameter', () => {
  const r = run(handler('\t\tvar oIn = JSON.parse(rs.getNString(1));'));
  assert.match(r.text, /if \(param\.data\.PAYLOAD !== undefined\)/);
});

test('the write-back becomes a return where nothing runs after it', () => {
  const r = run(handler(`\t\tvar out = { a: 1 };${WRITE_BACK}`));
  assert.match(r.text, /return JSON\.stringify\(out\);/);
  assert.doesNotMatch(r.text, /UPDATE/);
  const note = r.findings.find((f) => f.code === 'AFTER_TABLE_RESPONSE');
  assert.match(note.message, /it is now `return`/);
});

test('code after the write-back is not skipped — the answer is held and returned at the end', () => {
  const r = run(handler(`\t\tvar out = { a: 1 };${WRITE_BACK}`, '\tlog(1);'));
  assert.match(r.text, /neoResponse = JSON\.stringify\(out\);/);
  assert.match(r.text, /\n\tlog\(1\);/, 'the trailing statement still runs');
  assert.match(r.text, /\treturn neoResponse;\n\}/);
  assert.match(r.text, /\tlet neoResponse;/);
  assert.match(r.findings.find((f) => f.code === 'AFTER_TABLE_RESPONSE').message, /code runs after it/);
});

test('a return would be wrong inside a loop, so the write-back is held there too', () => {
  const src = `
function H(param) {
	var after = param.afterTableName;
	var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) {
		var oIn = JSON.parse(rs.getNString(1));
		for (var i = 0; i < oIn.n; i++) {
			var out = { i: i };${WRITE_BACK.replace(/\n\t\t/g, '\n\t\t\t')}
		}
	}
}
`;
  const r = run(src);
  assert.doesNotMatch(r.text, /return JSON\.stringify/);
  assert.match(r.text, /neoResponse = JSON\.stringify\(out\);/);
});

test('each function resolves its own `after` — one is not answered with another"s', () => {
  const src = `
function A(param) {
	var after = param.afterTableName;
	var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) { var a = rs.getNString(1); }
}
function B(req) {
	var after = req.afterTableName;
	var pstmt = req.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) { var b = rs.getNString(1); }
}
`;
  const r = run(src);
  assert.match(r.text, /a = param\.data\.PAYLOAD/);
  assert.match(r.text, /b = req\.data\.PAYLOAD/);
  // both local aliases go; neither function keeps a dead `after`
  assert.doesNotMatch(r.text, /afterTableName/);
});

test('an `after` still read by something else keeps its assignment', () => {
  const src = `
function H(param) {
	var after = param.afterTableName;
	log(after);
	var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) { var a = rs.getNString(1); }
}
`;
  const r = run(src);
  assert.match(r.text, /after = param\.afterTableName/);
  assert.match(r.text, /a = param\.data\.PAYLOAD/);
});

test('a multi-column read of the after table is left to the ordinary conversion', () => {
  const src = `
function H(param) {
	var after = param.afterTableName;
	var pstmt = param.connection.prepareStatement('SELECT ID, PAYLOAD FROM "' + after + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) { var a = rs.getNString(2); }
}
`;
  const r = run(src);
  assert.match(r.text, /cds\.run\(`SELECT ID, PAYLOAD FROM "\$\{after\}"`\)/);
  assert.ok(!codes(r).includes('AFTER_TABLE_PAYLOAD'));
});

test('a table name that is not afterTableName is not this idiom', () => {
  const src = `
function H(param) {
	var t = param.someOtherTable;
	var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + t + '"');
	var rs = pstmt.executeQuery();
	if (rs.next()) { var a = rs.getNString(1); }
}
`;
  const r = run(src);
  assert.match(r.text, /cds\.run\(/);
  assert.ok(!codes(r).includes('AFTER_TABLE_PAYLOAD'));
});
