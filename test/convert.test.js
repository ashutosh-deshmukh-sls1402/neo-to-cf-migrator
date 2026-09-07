import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert } from '../src/convert.js';

/** A throwaway NEO tree. `files` is {relative path: contents}. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo2cf-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const LIB = `
function doThing(param) {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT ID FROM "S"."T"');
  var rs = pstmt.executeQuery();
  var out = [];
  while (rs.next()) { out.push({ ID: rs.getNString(1) }); }
  return out;
}
`;

const XSODATA = `service {
  "S.MOD.Views::V" as "aliasOne"
  key("ID")
  create using "S.MOD.Library:MyLib.xsjslib::doThing";

  "S.MOD.Views::V" as "aliasTwo"
  key("ID")
  create using "S.MOD.Library:MyLib.xsjslib::notThere";
}`;

const codes = (r) => r.findings.map((f) => f.code);

test('convert emits a handler for every .xsjs/.xsjslib, at the srv/lib path', () => {
  const root = tree({ 'MOD/Library/MyLib.xsjslib': LIB, 'MOD/Entry.xsjs': 'function go() { return 1; }\ngo();\n' });
  const r = convert(root, { schema: 'S' });
  const handlers = r.files.filter((f) => f.role === 'handler').map((f) => f.path).sort();
  assert.deepEqual(handlers, [
    'srv/lib/S/MOD/Library/handlers/MyLib.js',
    'srv/lib/S/MOD/handlers/Entry.js',
  ]);
  const lib = r.files.find((f) => f.path.endsWith('MyLib.js'));
  assert.match(lib.text, /await cds\.run\(/);
  assert.match(lib.text, /export \{/);
  const entry = r.files.find((f) => f.path.endsWith('Entry.js'));
  assert.match(entry.text, /export default go;/);
});

test('an .xsodata wiring an entity to a function the library does not declare is reported', () => {
  const root = tree({
    'MOD/Library/MyLib.xsjslib': LIB,
    'MOD/Services/svc.xsodata': XSODATA,
  });
  const r = convert(root, { schema: 'S' });
  const missing = r.findings.filter((f) => f.code === 'HANDLER_EXPORT_MISSING');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /aliasTwo/);
  assert.match(missing[0].message, /notThere/);
});

test('a handler that would not parse is reported and not emitted', () => {
  // Two declarations of one name: legal in an XSJS script, fatal in a module.
  const root = tree({ 'MOD/Library/Dup.xsjslib': 'function f() { return 1; }\nfunction f() { return 2; }\n' });
  const r = convert(root, { schema: 'S' });
  assert.ok(codes(r).includes('DUPLICATE_FUNCTION'));
  assert.equal(r.files.filter((f) => f.role === 'handler').length, 0);
});

test('every relative import in the emitted JavaScript points at a file we also emit', () => {
  const root = tree({
    'MOD/Library/MyLib.xsjslib': LIB,
    'MOD/Other/Helper.xsjslib': 'function help() { return 2; }\n',
    'MOD/Entry.xsjs': '$.import("S.MOD.Other", "Helper");\nvar h = $.S.MOD.Other.Helper;\nfunction go() { return h.help(); }\ngo();\n',
  });
  const r = convert(root, { schema: 'S' });
  const emitted = new Set(r.files.map((f) => f.path));
  const specs = [];
  for (const f of r.files) {
    if (!f.path.endsWith('.js')) continue;
    for (const m of f.text.matchAll(/^import\s+(?:[\w${},*\s]+from\s+)?['"](\.[^'"]+)['"]/gm)) {
      specs.push(path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1])));
    }
  }
  assert.ok(specs.length, 'expected at least one relative import');
  for (const s of specs) assert.ok(emitted.has(s), `${s} is imported but never emitted`);
});
