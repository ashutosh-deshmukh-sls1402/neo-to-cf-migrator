import assert from 'node:assert/strict';
import { DEFAULT_TYPE_MAP, NO_LENGTH, cdsType } from '../src/emit/cdsproxy.js';

/**
 * Every type CAP's compiler accepts, and no more.
 *
 * Not from memory and not from the documentation: each of these was compiled by
 * `@sap/cds-compiler` 7.1.0 as `entity E { key ID : Integer; C : <type>; }` and
 * the list is what came back clean. `hana.NCLOB`, `hana.TEXT`, `hana.SHORTTEXT`
 * and `hana.BLOB` all look plausible and none of them exist — the first of those
 * shipped, and failed at compile time as `Artifact "cds.hana.NCLOB" has not been
 * found`, which is the second time an invented type reached a proxy (see
 * `Integer16` in cdsproxy.js). The compiler is not a dependency of this repo, so
 * this list standing in for it is the guard.
 */
const REAL_CDS_TYPES = new Set([
  'String', 'LargeString', 'LargeBinary', 'Binary',
  'Integer', 'Integer64', 'Int16', 'Decimal', 'Double',
  'Date', 'Time', 'Timestamp', 'DateTime', 'Boolean', 'UUID',
  'hana.CLOB', 'hana.TINYINT', 'hana.SMALLINT', 'hana.SMALLDECIMAL', 'hana.REAL',
  'hana.CHAR', 'hana.NCHAR', 'hana.VARCHAR', 'hana.BINARY',
  'hana.ST_POINT', 'hana.ST_GEOMETRY',
]);

test('every type the proxy emitter can produce is one the CDS compiler knows', () => {
  for (const [hana, cds] of Object.entries(DEFAULT_TYPE_MAP)) {
    assert.ok(REAL_CDS_TYPES.has(cds), `${hana} -> ${cds} is not a CDS type`);
  }
});

test('an NCLOB column is LargeString — there is no cds.hana.NCLOB', () => {
  assert.equal(DEFAULT_TYPE_MAP.NCLOB, 'LargeString');
  assert.equal(cdsType({ datatype: 'NCLOB', length: 5000 }).type, 'LargeString');
});

test('no type that rejects a length is ever emitted with one', () => {
  // `LargeString(100)` and `hana.CLOB(100)` are both compile errors.
  for (const [hana, cds] of Object.entries(DEFAULT_TYPE_MAP)) {
    if (!NO_LENGTH.has(cds)) continue;
    assert.equal(cdsType({ datatype: hana, length: 100 }).type, cds, `${hana} kept a length`);
  }
});

test('a length-carrying type keeps its length', () => {
  assert.equal(cdsType({ datatype: 'NVARCHAR', length: 40 }).type, 'String(40)');
});

test('an unknown HANA type is refused, never guessed', () => {
  const r = cdsType({ id: 'C', datatype: 'ST_CIRCLE' });
  assert.equal(r.type, null);
  assert.match(r.warning, /ST_CIRCLE/);
});
