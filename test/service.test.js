import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseXsodata } from '../src/parse/xsodata.js';
import { generateServiceJs, handlerPathFor } from '../src/emit/servicejs.js';
import { isInside, writeFiles } from '../src/core/write.js';

const XSODATA = `service {
  "S.APP.MOD.Views::V_Read" as "aliasRead"
  with("A","B")
  key("A");

  "S.APP.MOD.Views::V_Clob" as "aliasWrite"
  with("PAYLOAD","COL")
  key("COL")
  create using "S.APP.MOD.Library:MyLib.xsjslib::doThing";

  "S.APP.MOD.Views::V_Clob" as "aliasOther"
  key("COL")
  create using "S.APP.COMMON.Library:CommonUtil.xsjslib::ErrorHandling";
}`;

const OUT = 'srv/lib/S/APP/MOD/Services/service.js';
const gen = (src = XSODATA, opts = {}) =>
  generateServiceJs(parseXsodata(src), { schema: 'S', outPath: OUT, ...opts });

/* ---------------- library path resolution ---------------- */

test('a library reference maps onto the srv/lib tree', () => {
  assert.equal(
    handlerPathFor('S.APP.MOD.Library:MyLib.xsjslib', 'S'),
    'srv/lib/S/APP/MOD/Library/handlers/MyLib.js',
  );
});

test('.xsjs and .xsjslib both land in handlers/', () => {
  assert.equal(handlerPathFor('S.A:F.xsjs', 'S'), 'srv/lib/S/A/handlers/F.js');
  assert.equal(handlerPathFor('S.A:F.xsjslib', 'S'), 'srv/lib/S/A/handlers/F.js');
});

test('a malformed reference resolves to nothing rather than a wrong path', () => {
  assert.equal(handlerPathFor('no-colon-here', 'S'), null);
});

/* ---------------- service.js ---------------- */

test('only create-using entities get a handler; read-only projections do not', () => {
  const r = gen();
  assert.equal(r.bindings, 2);
  assert.doesNotMatch(r.text, /aliasRead/);
});

test('item 7b — the event name is the alias, never the literal CREATE', () => {
  const r = gen();
  assert.match(r.text, /srv\.on\('aliasWrite'/);
  assert.doesNotMatch(r.text, /'CREATE'/);
});

test('item 14 — req is passed straight through to the Library entry function', () => {
  assert.match(gen().text, /srv\.on\('aliasWrite', async \(req\) => await doThing\(req\)\);/);
});

test('item 7a — ES import, never require()', () => {
  const r = gen();
  assert.match(r.text, /^import \{/m);
  assert.doesNotMatch(r.text, /require\(/);
});

test('one import per library file, with a resolving relative specifier', () => {
  const r = gen();
  assert.equal(r.imports, 2);
  assert.match(r.text, /import \{ doThing \} from '\.\.\/Library\/handlers\/MyLib\.js';/);
  assert.match(r.text, /import \{ ErrorHandling \} from '\.\.\/\.\.\/COMMON\/Library\/handlers\/CommonUtil\.js';/);
});

test('the same function exported by two libraries is aliased, not shadowed', () => {
  const clash = `service {
    "S.A.Views::V" as "a1" key("C") create using "S.A.L1:One.xsjslib::doThing";
    "S.A.Views::V" as "a2" key("C") create using "S.A.L2:Two.xsjslib::doThing";
  }`;
  const r = gen(clash);
  assert.match(r.text, /doThing as doThing\$/);
  assert.ok(r.warnings.some((w) => /exported by more than one library/.test(w)));
  // Both aliases still get a distinct binding.
  assert.equal(r.bindings, 2);
});

test('a service of only read-only projections emits a valid empty module', () => {
  const r = gen(`service { "S.A.Views::V" as "only" key("C"); }`);
  assert.equal(r.bindings, 0);
  assert.match(r.text, /export default \(\) => \{\};/);
});

test('generateServiceJs refuses to guess the values it cannot derive', () => {
  assert.throws(() => generateServiceJs(parseXsodata(XSODATA), { outPath: OUT }), /schema/);
  assert.throws(() => generateServiceJs(parseXsodata(XSODATA), { schema: 'S' }), /outPath/);
});

/* ---------------- write guards ---------------- */

test('isInside catches an output dir nested in the NEO tree, case-insensitively', () => {
  assert.equal(isInside('C:/neo/out', 'C:/neo'), true);
  assert.equal(isInside('C:/NEO/OUT', 'c:/neo'), true);
  assert.equal(isInside('C:/neo', 'C:/neo'), true);
  assert.equal(isInside('C:/other', 'C:/neo'), false);
  // A sibling whose name merely starts with the same characters is NOT inside.
  assert.equal(isInside('C:/neo-out', 'C:/neo'), false);
});

test('writing into the NEO tree is refused', () => {
  const neo = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-'));
  assert.throws(
    () => writeFiles([{ path: 'a.txt', text: 'x' }], path.join(neo, 'out'), neo),
    /Refusing to write into the NEO tree/,
  );
});

test('an outstanding blocker stops the write unless forced', () => {
  const neo = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const files = [{ path: 'a/b.txt', text: 'hello' }];
  assert.throws(() => writeFiles(files, out, neo, { blockers: 2 }), /2 blocker\(s\) outstanding/);
  const r = writeFiles(files, out, neo, { blockers: 2, force: true });
  assert.equal(r.written, 1);
  assert.equal(fs.readFileSync(path.join(out, 'a/b.txt'), 'utf8'), 'hello');
});

test('service.js reports which function it wires each entity to, so the caller can check it exists', () => {
  const js = generateServiceJs(parseXsodata(XSODATA), {
    schema: 'S',
    outPath: 'srv/lib/S/APP/MOD/Services/service.js',
  });
  const wired = js.wired.find((b) => b.alias === 'aliasWrite');
  assert.equal(wired.fn, 'doThing');
  assert.equal(wired.target, 'srv/lib/S/APP/MOD/Library/handlers/MyLib.js');
});

test('a create using that does not name a function leaves the alias unwired', () => {
  // A NEO typo in the corpus: `…CommonUtil.xsjslib::ErrorHandling::ErrorHandling`.
  // The name is emitted verbatim in the import list, so emitting it broke the
  // whole service.js — one bad reference, every handler in the file gone.
  const r = gen(`service {
    "S.APP.MOD.Views::V" as "a" key("C")
    create using "S.APP.MOD.Library:MyLib.xsjslib::doThing::doThing";
  }`);
  assert.doesNotMatch(r.text, /doThing::doThing/);
  assert.ok(r.warnings.some((w) => /is not an identifier/.test(w)), r.warnings.join(' | '));
  assert.match(r.text, /export default \(\) => \{\};/);
});
