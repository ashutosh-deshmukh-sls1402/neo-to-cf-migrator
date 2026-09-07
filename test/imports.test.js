import assert from 'node:assert/strict';
import { transformFile } from '../src/transform/file.js';
import { handlerTargetFor } from '../src/transform/imports.js';
import { parse } from '../src/transform/js.js';

const REL = 'JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/Thing.xsjslib';
const run = (src, opts = {}) => transformFile(src, { schema: 'TECK', relPath: REL, ...opts });
const parses = (text) => { parse(text, { sourceType: 'module' }); return true; };

/* ---------------- where a package lands ---------------- */

test('a package path maps straight onto the emitted handler tree', () => {
  assert.equal(
    handlerTargetFor('TECK.Env_Config', 'CommonUtil', 'TECK').path,
    'srv/lib/TECK/Env_Config/handlers/CommonUtil.js',
  );
  assert.equal(
    handlerTargetFor('TECK.JOB_BIDDING.COMMON_View.Library', 'CommonUtil', 'TECK').path,
    'srv/lib/TECK/JOB_BIDDING/COMMON_View/Library/handlers/CommonUtil.js',
  );
});

test('a package under another schema is flagged rather than pointed somewhere wrong', () => {
  assert.equal(handlerTargetFor('ALGOMA.Outbound', 'Email', 'TECK').foreign, true);
  assert.equal(handlerTargetFor('TECK.Env_Config', 'CommonUtil', 'TECK').foreign, false);
});

/* ---------------- the two halves become one import ---------------- */

test('$.import plus its alias become a single ES import', () => {
  const r = run(`$.import("TECK.Env_Config", "CommonUtil");
var libEnvAth = $.TECK.Env_Config.CommonUtil;
function f() { return libEnvAth.doThing(); }`);
  assert.ok(parses(r.text));
  // Five levels up from .../JB_EMPPROFILE/Library/handlers/ lands on srv/lib/TECK.
  assert.match(r.text, /^import libEnvAth from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/Env_Config\/handlers\/CommonUtil\.js";/m);
  assert.doesNotMatch(r.text, /\$\.import/);
  assert.doesNotMatch(r.text, /\$\.TECK/);
  assert.match(r.text, /return libEnvAth\.doThing\(\);/);
});

test('the specifier is relative to where this file itself lands', () => {
  const r = run(
    `$.import("TECK.JOB_BIDDING.COMMON_View.Library", "CommonUtil");
var lib = $.TECK.JOB_BIDDING.COMMON_View.Library.CommonUtil;
function f() { return lib.x(); }`,
    { relPath: 'JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/Thing.xsjslib' },
  );
  assert.match(r.text, /from "\.\.\/\.\.\/\.\.\/\.\.\/COMMON_View\/Library\/handlers\/CommonUtil\.js"/);
});

test('a reference used inline, with no alias variable, is given one', () => {
  const r = run(`$.import("TECK.Env_Config", "CommonUtil");
function f() { return $.TECK.Env_Config.CommonUtil.doThing(); }`);
  assert.ok(parses(r.text));
  assert.match(r.text, /^import CommonUtil from ".*Env_Config\/handlers\/CommonUtil\.js";/m);
  assert.match(r.text, /return CommonUtil\.doThing\(\);/);
});

test('a member of an imported library is not mistaken for a deeper library', () => {
  const r = run(`$.import("TECK.JOB_BIDDING.AES", "AESLIB");
var aes = $.TECK.JOB_BIDDING.AES.AESLIB;
function f() { return $.TECK.JOB_BIDDING.AES.AESLIB.CryptoJS.enc; }`);
  assert.ok(parses(r.text));
  assert.equal(r.imports.length, 1);
  assert.match(r.text, /return aes\.CryptoJS\.enc;/);
});

test('an import whose module is never referenced is dropped', () => {
  const r = run(`$.import("TECK.Env_Config", "Unused");
function f() { return 1; }`);
  assert.ok(parses(r.text));
  assert.equal(r.imports.length, 0);
  assert.doesNotMatch(r.text, /\$\.import/);
  assert.ok(r.notes.some((n) => /never used/.test(n)));
});

test('two libraries with the same name keep their own aliases', () => {
  const r = run(`$.import("TECK.Env_Config", "CommonUtil");
$.import("TECK.JOB_BIDDING.COMMON_View.Library", "CommonUtil");
var libEnv = $.TECK.Env_Config.CommonUtil;
var libJb = $.TECK.JOB_BIDDING.COMMON_View.Library.CommonUtil;
function f() { return libEnv.a() + libJb.b(); }`);
  assert.ok(parses(r.text));
  assert.equal(r.imports.length, 2);
  assert.deepEqual(r.imports.map((i) => i.alias).sort(), ['libEnv', 'libJb']);
});

test('a foreign-schema package is reported, not silently pointed elsewhere', () => {
  const r = run(`$.import("ALGOMA.Outbound.Emails", "Email");
var mail = $.ALGOMA.Outbound.Emails.Email;
function f() { return mail.send(); }`);
  assert.ok(r.findings.some((f) => f.code === 'FOREIGN_PACKAGE_IMPORT'));
});

test('$.import called with something other than literals is reported', () => {
  const r = run(`$.import(pkgName, "CommonUtil");
function f() { return 1; }`);
  assert.ok(r.findings.some((f) => f.code === 'IMPORT_NOT_LITERAL'));
});

/* ---------------- exports ---------------- */

test('a converted .xsjslib exports its functions both ways', () => {
  const r = run(`function alpha() { return 1; }
function beta() { return 2; }`);
  assert.ok(parses(r.text));
  assert.match(r.text, /export default \{\n  alpha,\n  beta,\n\};/);
  assert.match(r.text, /export \{\n  alpha,\n  beta,\n\};/);
});

test('an .xsjs service gets no library export block — it is an entry point', () => {
  const r = run('function alpha() { return 1; }', { relPath: 'Services/Thing.xsjs' });
  assert.doesNotMatch(r.text, /export default/);
});

/* ---------------- composition with the database pass ---------------- */

test('imports and cds.run land in one file without fighting over the same bytes', () => {
  const r = run(`$.import("TECK.Env_Config", "CommonUtil");
var libEnvAth = $.TECK.Env_Config.CommonUtil;
function f() {
  var conn = $.db.getConnection();
  var p = conn.prepareStatement('SELECT A FROM "TECK"."T"');
  var rs = p.executeQuery();
  while (rs.next()) { libEnvAth.use(rs.getNString(1)); }
}`);
  assert.ok(parses(r.text));
  assert.equal(r.converted, 1);
  assert.match(r.text, /^import cds from "@sap\/cds";\nimport libEnvAth from ".*CommonUtil\.js";/);
  assert.match(r.text, /libEnvAth\.use\(rsRow\.A\)/);
});

test('with no relPath the import pass stays out of the way', () => {
  const r = transformFile(`$.import("TECK.Env_Config", "CommonUtil");
var lib = $.TECK.Env_Config.CommonUtil;`, { schema: 'TECK' });
  assert.equal(r.imports.length, 0);
  assert.match(r.text, /\$\.import/);
});
