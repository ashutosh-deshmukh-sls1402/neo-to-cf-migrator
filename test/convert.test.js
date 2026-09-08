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

/** A minimal script-based calc view; `id` is what the entity is named after. */
const VIEW = (id) => `<?xml version="1.0" encoding="UTF-8"?>
<Calculation:scenario xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore" id="${id}" schemaVersion="2.3" calculationScenarioType="SCRIPT_BASED">
<descriptions defaultDescription="${id}"/>
<localVariables/>
<variableMappings/>
<dataSources/>
<calculationViews>
  <calculationView xsi:type="Calculation:SqlScriptView" id="Script_View">
    <viewAttributes><viewAttribute id="COL" datatype="INTEGER"/></viewAttributes>
    <definition>BEGIN
var_out = select 1 as COL from DUMMY;
END</definition>
  </calculationView>
</calculationViews>
<logicalModel id="Script_View"/>
</Calculation:scenario>`;

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

test('one .cds per calc view by default; cdsProxy.bundle collapses them', () => {
  const files = { 'MOD/Views/V1.calculationview': VIEW('V1'), 'MOD/Views/V2.calculationview': VIEW('V2') };
  const spread = convert(tree(files), { schema: 'S' });
  assert.deepEqual(
    spread.files.filter((f) => f.role === 'cdsproxy').map((f) => f.path).sort(),
    ['db/cds/Views/S_MOD_VIEWS_V1.cds', 'db/cds/Views/S_MOD_VIEWS_V2.cds'],
  );

  const single = convert(tree(files), { schema: 'S', config: { cdsProxy: { bundle: 'all' } } });
  const proxies = single.files.filter((f) => f.role === 'cdsproxy');
  assert.deepEqual(proxies.map((f) => f.path), ['db/cds/schema.cds']);
  // every entity still there, each still saying which view it came from
  assert.match(proxies[0].text, /entity S_MOD_VIEWS_V1 \{/);
  assert.match(proxies[0].text, /entity S_MOD_VIEWS_V2 \{/);
  assert.equal(proxies[0].text.match(/converted from:/g).length, 2);
});

test("cdsProxy.bundle 'module' gives one .cds per top-level module", () => {
  const r = convert(
    tree({ 'MOD/Views/V1.calculationview': VIEW('V1'), 'OTHER/Views/V2.calculationview': VIEW('V2') }),
    { schema: 'S', config: { cdsProxy: { bundle: 'module' } } },
  );
  const proxies = r.files.filter((f) => f.role === 'cdsproxy');
  assert.deepEqual(
    proxies.map((f) => f.path).sort(),
    ['db/cds/MOD/MOD_schema.cds', 'db/cds/OTHER/OTHER_schema.cds'],
  );
  // each module's entities live only in that module's file
  const mod = proxies.find((f) => f.path.startsWith('db/cds/MOD/'));
  assert.match(mod.text, /entity S_MOD_VIEWS_V1 {/);
  assert.doesNotMatch(mod.text, /S_OTHER_VIEWS_V2/);
  // and the service.cds `using` follows the proxy to wherever it landed
});

/* ---------------- create-using actions and their payload ---------------- */

/** A library whose handler reads the payload out of the NEO after table. */
const EXIT = `
function doExit(param) {
  var after = param.afterTableName;
  var pstmt = param.connection.prepareStatement('SELECT PAYLOAD FROM "' + after + '"');
  var rs = pstmt.executeQuery();
  if (rs.next()) { var oIn = JSON.parse(rs.getNString(1)); }
}
`;

const xsodata = (entity) => `service {\n${entity}\n}`;

test('a create-using action declares the with(…) columns, minus the key', () => {
  const root = tree({
    'MOD/Library/Lib.xsjslib': EXIT,
    'MOD/Services/svc.xsodata': xsodata(`
  "S.MOD.Views::V" as "act"
  with("PAYLOAD","COL")
  key("COL")
  create using "S.MOD.Library:Lib.xsjslib::doExit";`),
    'MOD/Views/V.calculationview': VIEW('V'),
  });
  const cds = convert(root, { schema: 'S' }).files.find((f) => f.role === 'servicecds');
  assert.match(cds.text, /action act\(PAYLOAD: LargeString\) returns String;/);
});

test('a create-using entity with no with(…) still gets the parameter its handler reads', () => {
  const root = tree({
    'MOD/Library/Lib.xsjslib': EXIT,
    'MOD/Services/svc.xsodata': xsodata(`
  "S.MOD.Views::V" as "act"
  key("ID")
  create using "S.MOD.Library:Lib.xsjslib::doExit";`),
    'MOD/Views/V.calculationview': VIEW('V'),
  });
  const r = convert(root, { schema: 'S' });
  const cds = r.files.find((f) => f.role === 'servicecds');
  assert.match(cds.text, /action act\(PAYLOAD: LargeString\) returns String;/);
  assert.ok(codes(r).includes('ACTION_PAYLOAD_FROM_HANDLER'), codes(r).join(','));
  // and the handler reads exactly that name
  const js = r.files.find((f) => f.path.endsWith('handlers/Lib.js'));
  assert.match(js.text, /param\.data\.PAYLOAD/);
});

test('converting a subfolder puts back the package segments above it', () => {
  const files = {
    'RSM/Views/V.calculationview': VIEW('V'),
    'RSM/Services/svc.xsodata': xsodata(`
  "S.RSM.Views::V" as "a"
  key("ID")`),
  };
  // The whole repository: every reference resolves, nothing is inferred.
  const whole = convert(tree(files), { schema: 'S' });
  assert.equal(whole.findings.filter((f) => f.level === 'blocked').length, 0);
  assert.ok(!codes(whole).includes('NEO_SUBTREE_ROOT'));

  // Just the RSM folder: the .xsodata still says S.RSM.Views::V, which no path
  // under this directory can spell. Inferred, not refused.
  const sub = tree(files);
  const r = convert(path.join(sub, 'RSM'), { schema: 'S' });
  assert.equal(r.findings.filter((f) => f.level === 'blocked').length, 0, JSON.stringify(r.findings));
  const note = r.findings.find((f) => f.code === 'NEO_SUBTREE_ROOT');
  assert.match(note.message, /"RSM" subtree/);
  // the entity is named as it would be from the repository root
  assert.ok(r.files.some((f) => f.role === 'cdsproxy' && /entity S_RSM_VIEWS_V /.test(f.text)),
    r.files.filter((f) => f.role === 'cdsproxy').map((f) => f.text).join('\n'));
});

test('--root-package "" takes the folder paths literally', () => {
  const sub = tree({
    'RSM/Views/V.calculationview': VIEW('V'),
    'RSM/Services/svc.xsodata': xsodata(`
  "S.RSM.Views::V" as "a"
  key("ID")`),
  });
  const r = convert(path.join(sub, 'RSM'), { schema: 'S', config: { rootPackage: { package: '' } } });
  assert.ok(!codes(r).includes('NEO_SUBTREE_ROOT'));
  assert.ok(r.files.some((f) => f.role === 'cdsproxy' && /entity S_VIEWS_V /.test(f.text)));
  // and now the reference really does not resolve, which is the honest answer
  assert.ok(codes(r).includes('PROXY_NOT_FOUND'));
});

/* ---------------- AI_TIER_SUMMARY — telling "nothing eligible" from "never asked" ---------------- */

test('--ai with nothing to ask says so, not just "0 findings"', () => {
  // A handler that already returns, and no SQL at all: nothing for either
  // Tier 2 task to look at.
  const root = tree({ 'MOD/Library/MyLib.xsjslib': 'function f() { return 1; }\n' });
  const ai = { name: 'stub', ask: () => '{"variable":"unknown"}' };
  const r = convert(root, { schema: 'S', ai });
  const note = r.findings.find((f) => f.code === 'AI_TIER_SUMMARY');
  assert.ok(note, 'expected an AI_TIER_SUMMARY finding when --ai is given');
  assert.match(note.message, /never asked/);
});

test('no --ai at all means no AI_TIER_SUMMARY — only given a backend is this worth saying', () => {
  const root = tree({ 'MOD/Library/MyLib.xsjslib': 'function f() { return 1; }\n' });
  const r = convert(root, { schema: 'S' });
  assert.ok(!codes(r).includes('AI_TIER_SUMMARY'));
});

test('--ai that is actually asked reports how many times, and how many were accepted', () => {
  const root = tree({
    'MOD/Library/MyLib.xsjslib': 'function h() { var out; return out; }\nfunction empty() { var payload = {}; }\n',
    'MOD/Services/svc.xsodata': `service {
  "S.MOD.Views::V" as "aliasOne"
  key("ID")
  create using "S.MOD.Library:MyLib.xsjslib::empty";
}`,
  });
  const ai = { name: 'stub', ask: () => '{"variable":"payload"}' };
  const r = convert(root, { schema: 'S', ai });
  const note = r.findings.find((f) => f.code === 'AI_TIER_SUMMARY');
  assert.ok(note);
  assert.match(note.message, /asked 1 time\(s\)/);
  assert.match(note.message, /1 accepted/);
});
