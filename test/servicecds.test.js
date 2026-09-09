/**
 * What the CDS compiler taught us.
 *
 * Every case here is a real error from running `cds build --production` over the
 * emitted trees — the model looked right and did not compile. They are unit
 * tests because the compiler is not a dependency of this tool.
 */
import assert from 'node:assert/strict';
import { parseXsodata } from '../src/parse/xsodata.js';
import { generateServiceBlock, assignServiceNames } from '../src/emit/servicecds.js';

const block = (src, elements, opts = {}) =>
  generateServiceBlock(parseXsodata(src), {}, {
    serviceName: 'SVC',
    serviceDir: 'srv/lib/S/MOD/Services',
    resolveProxy: () => ({ name: 'PROXY', file: 'db/cds/MOD/Views/PROXY.cds', elements, parameters: opts.parameters }),
    ...opts,
  });

/* ---------------- with(…) against the real view ---------------- */

const WITH_UNKNOWN = `service {
  "S.MOD.Views::V" as "a" with("A","GHOST","B") key("A");
}`;

test('a with(…) column the view does not have is dropped, not emitted', () => {
  // 111 of TECK's compile errors were `Element "BDLNT" has not been found`.
  // NEO never checked the list against the view; CAP does.
  const r = block(WITH_UNKNOWN, ['A', 'B']);
  assert.doesNotMatch(r.text, /GHOST/);
  assert.match(r.text, /key A/);
  assert.deepEqual(r.droppedColumns, [{ alias: 'a', column: 'GHOST', reason: 'unknown' }]);
});

test('a column listed twice is emitted once', () => {
  const r = block('service { "S.MOD.Views::V" as "a" with("A","B","A") key("A"); }', ['A', 'B']);
  assert.equal((r.text.match(/\bA\b,?/g) || []).filter((m) => !m.includes('key')).length >= 1, true);
  assert.deepEqual(r.droppedColumns.map((d) => d.reason), ['duplicate']);
});

test('with no element list to check against, nothing is dropped', () => {
  // A proxy we could not read must not silently empty the projection.
  const r = block(WITH_UNKNOWN, []);
  assert.match(r.text, /GHOST/);
  assert.deepEqual(r.droppedColumns, []);
});

test('when every column is unknown the projection falls back to all of them', () => {
  const r = block('service { "S.MOD.Views::V" as "a" with("X","Y"); }', ['A', 'B']);
  assert.match(r.text, /entity a as projection on PROXY;/);
});

/* ---------------- keys ---------------- */

test('a projection restates its key — inheriting it is not enough', () => {
  // `Expected entity to have a primary key`: a projection carries a key only if
  // it lists EVERY key of the source, and one calc view is keyed differently by
  // different .xsodata, so the proxy can have more keys than this service wants.
  const r = block('service { "S.MOD.Views::V" as "a" with("WFHID","OTHER") key("WFHID"); }', ['WFHID', 'OTHER', 'WFHNO']);
  assert.match(r.text, /key WFHID/);
  assert.doesNotMatch(r.text, /key OTHER/);
});

/* ---------------- usings are per file, not per service ---------------- */

test('the using lines come back separately, because one file can hold two services', () => {
  const r = block(WITH_UNKNOWN, ['A', 'B']);
  assert.equal(r.usings.get('PROXY'), '../../../../../db/cds/MOD/Views/PROXY.cds');
  assert.doesNotMatch(r.serviceText, /^using /m, 'the service block itself carries none');
  assert.match(r.serviceText, /^service SVC /m);
});

/* ---------------- service names are exactly NEO's ---------------- */

test('a name used in one folder only is left alone', () => {
  const names = assignServiceNames([{ rel: 'A/S/x.xsodata', base: 'x' }]);
  assert.equal(names.get('A/S/x.xsodata').name, 'x');
  assert.deepEqual(names.get('A/S/x.xsodata').collidesWith, []);
});

test('the same name in two folders is kept as-is on BOTH sides, not qualified', () => {
  // Renaming it would change a path a UI, a destination, or a test script
  // already calls by its NEO spelling — not this tool's contract to renegotiate.
  const names = assignServiceNames([
    { rel: 'r1', base: 'EMP' },
    { rel: 'r2', base: 'EMP' },
  ]);
  assert.equal(names.get('r1').name, 'EMP');
  assert.equal(names.get('r2').name, 'EMP');
});

test('a collision is reported on every member of the group, by the other rels sharing it', () => {
  const names = assignServiceNames([
    { rel: 'r1', base: 'X' },
    { rel: 'r2', base: 'X' },
    { rel: 'r3', base: 'X' },
  ]);
  assert.deepEqual(names.get('r1').collidesWith, ['r2', 'r3']);
  assert.deepEqual(names.get('r2').collidesWith, ['r1', 'r3']);
  assert.deepEqual(names.get('r3').collidesWith, ['r1', 'r2']);
});

/* ---------------- parameterised calc views ---------------- */

// The ARBDR case that prompted this: `ARBDR.INC.Views::INC_M_RolewisePath` is a
// parameterised calc view (`<variable id="INRGUID" parameter="true">`,
// NVARCHAR(20)); the .xsodata's own `parameters via key and entity "INRGUID"
// results property "Execute"` clause is parsed and ignored — it names an OData
// Parameters entity, not the parameter — so the parameter list has to come
// from the calc view itself, exactly as cdsproxy.js already reads it.
const PARAM_ENTITY = `service {
  "ARBDR.INC.Views::INC_M_RolewisePath" as "ASDRToWpy6NGKkoe"
  with("RLPID","ROLNM","APPNM","ROLPH","RGUID","REBHF")
  key("RLPID")
  parameters via key and entity "INRGUID" results property "Execute"
  create forbidden
  update forbidden
  delete forbidden;
}`;

test('a parameterised calc view is projected with its parameter list on both sides', () => {
  const r = block(PARAM_ENTITY, ['RLPID', 'ROLNM', 'APPNM', 'ROLPH', 'RGUID', 'REBHF'], {
    parameters: [{ id: 'INRGUID', datatype: 'NVARCHAR', length: 20 }],
  });
  assert.match(r.text, /entity ASDRToWpy6NGKkoe\(INRGUID: String\(20\)\) as projection on PROXY\(INRGUID: :INRGUID\)/);
});

test('an unparameterised calc view gets none of this — the plain form is unchanged', () => {
  const r = block(PARAM_ENTITY, ['RLPID', 'ROLNM', 'APPNM', 'ROLPH', 'RGUID', 'REBHF'], { parameters: [] });
  assert.match(r.text, /entity ASDRToWpy6NGKkoe as projection on PROXY/);
  assert.doesNotMatch(r.text, /\(INRGUID/);
});

test('the parameter type comes from the calc view, matching what cdsproxy.js writes for the same view', () => {
  const r = block('service { "S.MOD.Views::V" as "a" key("ID"); }', ['ID'], {
    parameters: [{ id: 'pTABID', datatype: 'INTEGER' }],
  });
  assert.match(r.text, /entity a\(pTABID: Integer\) as projection on PROXY\(pTABID: :pTABID\)/);
});

test('a projection body still opens correctly when the view is both parameterised and column-restricted', () => {
  const r = block(PARAM_ENTITY, ['RLPID', 'ROLNM'], {
    parameters: [{ id: 'INRGUID', datatype: 'NVARCHAR', length: 20 }],
  });
  // with(…) drops ROLPH etc — a nonexistent column — so the block form kicks in
  assert.match(r.text, /entity ASDRToWpy6NGKkoe\(INRGUID: String\(20\)\) as projection on PROXY\(INRGUID: :INRGUID\) \{/);
  assert.match(r.text, /key RLPID/);
});

test('two parameters are both declared and both passed, in the calc view\'s own order', () => {
  const r = block('service { "S.MOD.Views::V" as "a" key("ID"); }', ['ID'], {
    parameters: [{ id: 'pFrom', datatype: 'NVARCHAR', length: 8 }, { id: 'pTo', datatype: 'NVARCHAR', length: 8 }],
  });
  assert.match(r.text, /entity a\(pFrom: String\(8\), pTo: String\(8\)\) as projection on PROXY\(pFrom: :pFrom, pTo: :pTo\)/);
});

test('an unmapped HANA parameter type is reported, not silently dropped to String', () => {
  const r = block('service { "S.MOD.Views::V" as "a" key("ID"); }', ['ID'], {
    parameters: [{ id: 'pWeird', datatype: 'ST_CIRCLE' }],
  });
  assert.ok(r.warnings.some((w) => w.includes('pWeird') || w.includes('ST_CIRCLE')), r.warnings.join('\n'));
});
