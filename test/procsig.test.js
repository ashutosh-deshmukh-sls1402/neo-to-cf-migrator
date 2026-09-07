import assert from 'node:assert/strict';
import { parseProcedureSignature, procedureIndex, lookupProcedure } from '../src/parse/procsig.js';
import { transformFile } from '../src/transform/file.js';
import { parse } from '../src/transform/js.js';

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const parses = (text) => { parse(text, { sourceType: 'module' }); return true; };

/* ---------------- reading the signature ---------------- */

test('IN and OUT parameters are read off the procedure header', () => {
  const sig = parseProcedureSignature(`
PROCEDURE "S"."S.PKG.Procedures::prCreate"
(
    IN JOBID BIGINT,
    IN ACTTP NVARCHAR(200),   -- a comma inside the comment, and (parens)
    OUT OPK_ID BIGINT
)
LANGUAGE SQLSCRIPT AS BEGIN END;`);
  assert.equal(sig.name, 'S.PKG.Procedures::prCreate');
  assert.deepEqual(sig.params.map((p) => `${p.mode} ${p.name}`), ['IN JOBID', 'IN ACTTP', 'OUT OPK_ID']);
});

test('an unmarked parameter is IN — that is the HANA default, and the corpus relies on it', () => {
  const sig = parseProcedureSignature('PROCEDURE "p" (\n IN A INTEGER,\n TYPES SMALLINT,\n out oPMKID INTEGER\n) AS BEGIN END;');
  assert.deepEqual(sig.params.map((p) => p.mode), ['IN', 'IN', 'OUT']);
  assert.equal(sig.params[2].name, 'OPMKID');
});

test('a header we cannot read returns null rather than a partial signature', () => {
  // Half a signature would name the wrong OUT parameter, which is worse than
  // refusing the statement.
  assert.equal(parseProcedureSignature('PROCEDURE "p" ( IN A INTEGER, ??? ) AS BEGIN END;'), null);
  assert.equal(parseProcedureSignature('SELECT 1 FROM DUMMY'), null);
});

/* ---------------- finding it from a CALL ---------------- */

const index = () => {
  const sigs = new Map();
  const idx = { byPath: new Map(), byName: new Map() };
  const sig = parseProcedureSignature('PROCEDURE "x" (IN A INTEGER, OUT B BIGINT) AS BEGIN END;');
  idx.byPath.set('PKG.PROCEDURES::PRDOTHING', sig);
  idx.byName.set('PRDOTHING', sig);
  return idx;
};

test('every spelling of a CALL path finds the same procedure', () => {
  const idx = index();
  for (const sql of [
    'CALL "S"."S.PKG.Procedures::prDoThing"(?,?)',
    'CALL "S.PKG.Procedures::prDoThing"(?,?)',
    'CALL"S.PKG.Procedures::prDoThing"(?,?)',
  ]) {
    assert.ok(lookupProcedure(idx, sql, 'S'), sql);
  }
});

test('a procedure that is not in the tree is not guessed at', () => {
  assert.equal(lookupProcedure(index(), 'CALL "S.OTHER::pSomethingElse"(?)', 'S'), null);
});

test('two procedures of the same name with different signatures drop the name key', () => {
  const idx = procedureIndex('/nonexistent', []);
  assert.equal(idx.byName.size, 0);
});

/* ---------------- what it buys ---------------- */

const PROCS = () => {
  const idx = { byPath: new Map(), byName: new Map() };
  const sig = parseProcedureSignature('PROCEDURE "p" (IN JOBID BIGINT, IN ACTTP NVARCHAR(20), OUT OPK_BDSID BIGINT) AS BEGIN END;');
  idx.byName.set('PRCREATESUMMARY', sig);
  idx.byPath.set('PKG::PRCREATESUMMARY', sig);
  return idx;
};

const SRC = `function f(param) {
  var cstmt, SUMID;
  cstmt = param.connection.prepareCall("CALL \\"S.PKG::prCreateSummary\\"(?,?,?)");
  cstmt.setInteger(1, param.job);
  cstmt.setNString(2, param.type);
  cstmt.execute();
  SUMID = cstmt.getInteger(3);
  return SUMID;
}`;

test('an unbound trailing ? is an OUT parameter, read back by name', () => {
  const out = transformFile(SRC, { schema: 'S', procs: PROCS() });
  assert.ok(parses(out.text));
  assert.match(squash(out.text), /const callResult = await cds\.run\(`CALL S_PKG_prCreateSummary\(\?,\?,\?\)`, \[param\.job, param\.type\]\)/);
  assert.match(out.text, /SUMID = callResult\.OPK_BDSID;/);
  assert.equal(out.findings.filter((f) => f.level !== 'note').length, 0);
});

test('without the procedure the same statement keeps its refusal — no guessed name', () => {
  const out = transformFile(SRC, { schema: 'S' });
  assert.match(out.text, /BIND_COUNT_MISMATCH/);
  assert.ok(!/callResult/.test(out.text));
});

test('a getter reading a position the procedure declares IN is refused and named', () => {
  // A real defect in the corpus: the code prepares one statement and reads the
  // OUT parameter off a different one.
  const src = SRC.replace('cstmt.getInteger(3)', 'cstmt.getInteger(2)');
  const out = transformFile(src, { schema: 'S', procs: PROCS() });
  assert.match(out.text, /CALL_OUT_UNKNOWN/);
  assert.ok(!/callResult/.test(out.text));
});

test('when the execute is already assigned, that variable carries the OUT values', () => {
  const src = SRC.replace('cstmt.execute();', 'var r = cstmt.execute();').replace('cstmt.getInteger(3)', 'cstmt.getInteger(3)');
  const out = transformFile(src, { schema: 'S', procs: PROCS() });
  assert.ok(parses(out.text));
  assert.match(out.text, /SUMID = r\.OPK_BDSID;/);
  assert.ok(!/callResult/.test(out.text));
});

test('an OUT parameter nobody reads still converts — there is nothing to name', () => {
  const src = SRC.replace('  SUMID = cstmt.getInteger(3);\n', '');
  const out = transformFile(src, { schema: 'S', procs: PROCS() });
  assert.ok(parses(out.text));
  assert.ok(!/BIND_COUNT_MISMATCH/.test(out.text));
  assert.ok(!/const callResult/.test(out.text), 'nothing reads it, so nothing needs naming');
});
