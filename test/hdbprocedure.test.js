import assert from 'node:assert/strict';
import { generateProcedure } from '../src/emit/hdbprocedure.js';

const CFG = { schemas: { strippable: ['ARBDR'] } };
const gen = (src, cfg = CFG) => generateProcedure(src, cfg);

const PROC = `/* Procedure Name : prX.hdbprocedure */
PROCEDURE "ARBDR"."ARBDR.RSM.Inbound.Procedures::prCreateUpdateLMSMasterdata" (
    LMSID   NVARCHAR(200)
)
   LANGUAGE SQLSCRIPT
   SQL SECURITY INVOKER
   DEFAULT SCHEMA ARBDR
   AS
BEGIN
    SELECT COUNT(1) INTO CNT FROM "ARBDR"."RSM_M_LMSDT" WHERE LMSID =:LMSID;
    INSERT INTO "ARBDR"."RSM_M_LMSDT" (LMSID, CRTBY) VALUES (:LMSID, SESSION_USER);
END`;

test('the declared name is flattened to the name a handler CALLs', () => {
  const r = gen(PROC);
  assert.equal(r.name, 'ARBDR_RSM_INBOUND_PROCEDURES_PRCREATEUPDATELMSMASTERDATA');
  assert.match(r.text, /PROCEDURE "ARBDR_RSM_INBOUND_PROCEDURES_PRCREATEUPDATELMSMASTERDATA" \(/);
  // the "SCHEMA". in front of it goes with the flattening
  assert.doesNotMatch(r.text, /PROCEDURE "ARBDR"\./);
  assert.deepEqual(r.warnings, []);
});

test('the schema qualifier is stripped from every table in the body', () => {
  const r = gen(PROC);
  assert.match(r.text, /FROM "RSM_M_LMSDT"/);
  assert.match(r.text, /INSERT INTO "RSM_M_LMSDT"/);
  assert.doesNotMatch(r.text, /"ARBDR"\."RSM_M_LMSDT"/);
  assert.equal(r.transforms.schemasStripped, 2);
});

test('DEFAULT SCHEMA goes — the HDI container names its own schema', () => {
  assert.doesNotMatch(gen(PROC).text, /DEFAULT SCHEMA/i);
  const quoted = gen(PROC.replace('DEFAULT SCHEMA ARBDR', 'DEFAULT SCHEMA "ARBDR"'));
  assert.doesNotMatch(quoted.text, /DEFAULT SCHEMA/i);
  assert.equal(quoted.transforms.defaultSchemaDropped, 1);
  // and the clause it sat on does not leave a blank line behind
  assert.match(quoted.text, /SQL SECURITY INVOKER\n   AS/);
});

test('SESSION_USER is replaced — the CF connection is a technical user', () => {
  assert.match(gen(PROC).text, /SESSION_CONTEXT\('APPLICATIONUSER'\)/);
  assert.doesNotMatch(gen(PROC).text, /SESSION_USER/);
});

test('a foreign schema is left alone and reported', () => {
  const r = gen(PROC.replace('"ARBDR"."RSM_M_LMSDT" WHERE', '"ULA"."MASTER" WHERE'));
  assert.match(r.text, /FROM "ULA"\."MASTER"/);
  assert.deepEqual(r.foreignSchemas, ['ULA']);
});

test('DEFAULT SCHEMA naming somebody else"s schema is a decision, not a typo', () => {
  const r = gen(PROC.replace('DEFAULT SCHEMA ARBDR', 'DEFAULT SCHEMA ULA'));
  assert.match(r.text, /DEFAULT SCHEMA ULA/);
  assert.equal(r.warnings[0].code, 'DEFAULT_SCHEMA_FOREIGN');
});

test('a nested CALL to another NEO procedure is flattened the same way', () => {
  const r = gen(PROC.replace('END', 'CALL "ARBDR.RSM.Procedures::prGetSequence"(:LMSID);\nEND'));
  assert.match(r.text, /CALL ARBDR_RSM_PROCEDURES_PRGETSEQUENCE\(:LMSID\)/);
  assert.equal(r.transforms.callsFlattened, 1);
});

test('comments are never rewritten — the scanner only touches executable SQL', () => {
  const r = gen(PROC.replace('BEGIN', 'BEGIN\n  -- SELECT 1 FROM "ARBDR"."OLD_TABLE";'));
  assert.match(r.text, /-- SELECT 1 FROM "ARBDR"\."OLD_TABLE";/);
});

test('a header that is not a NEO repository path is left alone, and said so', () => {
  const r = gen('PROCEDURE "SOME_FLAT_NAME" ()\nAS BEGIN\n SELECT 1 FROM DUMMY;\nEND');
  assert.equal(r.name, null);
  assert.match(r.text, /PROCEDURE "SOME_FLAT_NAME"/);
  assert.equal(r.warnings[0].code, 'PROCEDURE_NAME_UNCHANGED');
});

test('the word "procedure" in a comment is not a declaration', () => {
  const r = gen(PROC);
  assert.match(r.text, /\/\* Procedure Name : prX\.hdbprocedure \*\//);
});
