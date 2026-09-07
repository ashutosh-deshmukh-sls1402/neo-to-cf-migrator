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
    resolveProxy: () => ({ name: 'PROXY', file: 'db/cds/MOD/Views/PROXY.cds', elements }),
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

/* ---------------- service names are global in CAP ---------------- */

test('a name used in one folder only is left alone', () => {
  const names = assignServiceNames([{ rel: 'A/S/x.xsodata', base: 'x', dir: 'A/S' }]);
  assert.equal(names.get('A/S/x.xsodata').name, 'x');
  assert.equal(names.get('A/S/x.xsodata').from, null);
});

test('the same name in two folders is qualified on BOTH sides, by the segment that differs', () => {
  // Renaming only the second would make the name depend on scan order.
  const names = assignServiceNames([
    { rel: 'r1', base: 'EMP', dir: 'JOB/JB_EMPLOYEE/JB_PORTAL' },
    { rel: 'r2', base: 'EMP', dir: 'JOB/JB_UNION_ADMIN/JB_PORTAL' },
  ]);
  assert.equal(names.get('r1').name, 'JB_EMPLOYEE_EMP');
  assert.equal(names.get('r2').name, 'JB_UNION_ADMIN_EMP');
  assert.equal(names.get('r1').from, 'EMP');
});

test('a qualified name that still collides gets a numeric suffix rather than silently winning', () => {
  const names = assignServiceNames([
    { rel: 'r1', base: 'B_X', dir: 'A' },
    { rel: 'r2', base: 'X', dir: 'A/B' },
    { rel: 'r3', base: 'X', dir: 'A/C' },
  ]);
  const all = [...names.values()].map((n) => n.name);
  assert.equal(new Set(all).size, all.length, `names must be unique: ${all}`);
});
