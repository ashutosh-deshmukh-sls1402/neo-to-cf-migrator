import assert from 'node:assert/strict';
import { transformFile } from '../src/transform/file.js';
import { parse } from '../src/transform/js.js';

const XSJS = 'Env_Config/Thing.xsjs';
const LIB = 'Env_Config/Library/Thing.xsjslib';
const run = (src, rel = XSJS) => transformFile(src, { schema: 'TECK', relPath: rel, filename: rel });
const parses = (text) => { parse(text, { sourceType: 'module' }); return true; };
const codes = (out) => out.findings.map((f) => f.code);

/* ---------------- the entry point ---------------- */

test('the one top-level call names the entry function, which takes req and is exported', () => {
  const out = run(`
function processRequest() {
  $.response.setBody("hi");
}
processRequest();
`);
  assert.match(out.text, /function processRequest\(req\)/);
  assert.match(out.text, /export default processRequest;/);
  assert.doesNotMatch(out.text, /^processRequest\(\);/m);
  assert.equal(out.entry, 'processRequest');
  assert.ok(parses(out.text));
});

test('a .xsjslib is a library, so nothing is exported as the default', () => {
  const out = run(`
function helper() { return 1; }
helper();
`, LIB);
  assert.equal(out.entry, null);
  assert.doesNotMatch(out.text, /export default helper/);
});

test('two top-level calls are ambiguous, so the entry is reported rather than picked', () => {
  const out = run(`
function a() { $.response.setBody("x"); }
function b() { return 1; }
a();
b();
`);
  assert.ok(codes(out).includes('NO_REQUEST_ENTRY'));
  assert.equal(out.entry, null);
});

test('a file with no top-level call at all is reported, not guessed at', () => {
  const out = run(`
function handleGet() { $.response.setBody("x"); }
`);
  assert.ok(codes(out).includes('NO_REQUEST_ENTRY'));
});

test('an entry function that already takes parameters keeps them and is flagged', () => {
  const out = run(`
function processRequest(opts) { $.response.setBody(opts); }
processRequest();
`);
  assert.ok(codes(out).includes('ENTRY_HAS_PARAMETERS'));
  assert.match(out.text, /function processRequest\(opts\)/);
});

/* ---------------- the method switch ---------------- */

test('a single-method switch collapses to its case body', () => {
  const out = run(`
function processRequest() {
  switch ($.request.method) {
    case $.net.http.POST:
      $.response.setBody(handlePost());
      break;
    default:
      $.response.status = $.net.http.METHOD_NOT_ALLOWED;
      $.response.setBody("Wrong request method");
      break;
  }
}
processRequest();
`);
  assert.doesNotMatch(out.text, /switch \(/);
  assert.doesNotMatch(out.text, /METHOD_NOT_ALLOWED/);
  assert.match(out.text, /return handlePost\(\);/);
  assert.ok(parses(out.text));
});

test('a switch over two methods is left alone and reported — CAP routes one action per handler', () => {
  const out = run(`
function processRequest() {
  switch ($.request.method) {
    case $.net.http.GET: $.response.setBody(a()); break;
    case $.net.http.POST: $.response.setBody(b()); break;
  }
}
processRequest();
`);
  assert.ok(codes(out).includes('MULTI_METHOD_DISPATCH'));
  assert.match(out.text, /switch \(/);
  assert.match(out.text, /NEEDS HUMAN REVIEW/);
});

test('$.request.method outside a switch becomes req.event', () => {
  const out = run(`
function processRequest() {
  if ($.request.method === $.net.http.GET) { $.response.setBody("x"); }
}
processRequest();
`);
  assert.match(out.text, /req\.event === "GET"/);
});

/* ---------------- the payload ---------------- */

test('JSON.parse($.request.body.asString()) folds to the parsed request data', () => {
  const out = run(`
function processRequest() {
  var o = JSON.parse($.request.body.asString());
  $.response.setBody(o);
}
processRequest();
`);
  assert.match(out.text, /var o = req\.data;/);
  assert.doesNotMatch(out.text, /JSON\.parse/);
});

test('a bare asString() keeps its string type', () => {
  const out = run(`
function processRequest() { $.response.setBody($.request.body.asString()); }
processRequest();
`);
  assert.match(out.text, /return JSON\.stringify\(req\.data\);/);
});

test('a named request parameter becomes a req.data field', () => {
  const out = run(`
function processRequest() { $.response.setBody($.request.parameters.get("OBJECTID")); }
processRequest();
`);
  assert.match(out.text, /return req\.data\.OBJECTID;/);
});

test('a positional request parameter is reported — the name is not in the file', () => {
  const out = run(`
function processRequest() { $.response.setBody($.request.parameters[0].value); }
processRequest();
`);
  assert.ok(codes(out).includes('PARAMETER_BY_POSITION'));
});

/* ---------------- req vs cds.context ---------------- */

test('a helper reaches the request through cds.context, where req is not in scope', () => {
  const out = run(`
function helper() { return $.request.body.asString(); }
function processRequest() { $.response.setBody(helper()); }
processRequest();
`);
  assert.match(out.text, /function helper\(\) \{ return JSON\.stringify\(cds\.context\.data\); \}/);
  assert.match(out.text, /^import cds from "@sap\/cds";/m);
  assert.ok(parses(out.text));
});

test('$.session.getUsername works in a library, where there is no req at all', () => {
  const out = run(`
function whoami() { return $.session.getUsername(); }
`, LIB);
  assert.match(out.text, /return cds\.context\.user\.id;/);
  assert.match(out.text, /^import cds from "@sap\/cds";/m);
});

/* ---------------- the response ---------------- */

test('setBody at the end of a branch becomes a return', () => {
  const out = run(`
function processRequest() { $.response.setBody(JSON.stringify(handleGet())); }
processRequest();
`);
  assert.match(out.text, /return JSON\.stringify\(handleGet\(\)\);/);
});

test('setBody with code after it would change the flow, so it is reported instead', () => {
  const out = run(`
function processRequest() {
  $.response.setBody("x");
  cleanup();
}
processRequest();
`);
  assert.ok(codes(out).includes('RESPONSE_BODY_MIDBLOCK'));
  assert.match(out.text, /\$\.response\.setBody/);
});

test('an error status and the body after it fold into one req.reject', () => {
  const out = run(`
function processRequest() {
  $.response.status = $.net.http.BAD_REQUEST;
  $.response.setBody("nope");
}
processRequest();
`);
  assert.match(out.text, /return req\.reject\(400, "nope"\);/);
  assert.doesNotMatch(out.text, /\$\.response/);
  assert.ok(parses(out.text));
});

test('an error status followed by a return folds the returned value in', () => {
  const out = run(`
function processRequest() {
  $.response.status = $.net.http.INTERNAL_SERVER_ERROR;
  return { myResult: "Missing BODY" };
}
processRequest();
`);
  assert.match(out.text, /return req\.reject\(500, \{ myResult: "Missing BODY" \}\);/);
});

test('a success status is CAP\'s to choose, so the assignment simply goes', () => {
  const out = run(`
function processRequest() {
  $.response.status = $.net.http.OK;
  $.response.setBody("done");
}
processRequest();
`);
  assert.doesNotMatch(out.text, /status/);
  assert.match(out.text, /return "done";/);
});

test('setBody in a catch reports a failure, so it rejects rather than returning 200', () => {
  const out = run(`
function processRequest() {
  try { work(); } catch (e) { $.response.setBody("Failed: " + e.toString()); }
}
processRequest();
`);
  assert.match(out.text, /return req\.reject\(500, "Failed: " \+ e\.toString\(\)\);/);
  assert.ok(codes(out).includes('CATCH_STATUS_ASSUMED'));
});

test('contentType is dropped, and a non-JSON one is reported', () => {
  const out = run(`
function processRequest() {
  $.response.setBody(x());
  $.response.contentType = "application/pdf";
}
processRequest();
`);
  assert.doesNotMatch(out.text, /contentType/);
  assert.ok(codes(out).includes('RESPONSE_CONTENT_TYPE'));
});

test('a status set part-way through a block is reported, not turned into a return', () => {
  const out = run(`
function processRequest() {
  $.response.status = $.net.http.BAD_REQUEST;
  log("still going");
  $.response.setBody("x");
}
processRequest();
`);
  assert.ok(codes(out).includes('RESPONSE_STATUS_MIDBLOCK'));
  assert.match(out.text, /\$\.response\.status/);
});

/* ---------------- odds and ends ---------------- */

test('base64 helpers become Buffer, keeping the argument editable', () => {
  const out = run(`
function processRequest() {
  var a = $.util.codec.encodeBase64($.request.body.asString());
  var b = $.util.codec.decodeBase64(a);
  $.response.setBody(b);
}
processRequest();
`);
  assert.match(out.text, /Buffer\.from\(JSON\.stringify\(req\.data\)\)\.toString\("base64"\)/);
  assert.match(out.text, /Buffer\.from\(a, "base64"\)\.toString\(\)/);
  assert.ok(parses(out.text));
});

test('$.response.headers.set has no handler equivalent, so it is reported', () => {
  const out = run(`
function processRequest() { $.response.headers.set("allow", "GET"); }
processRequest();
`);
  assert.ok(codes(out).includes('RESPONSE_HEADER_SET'));
});

test('the request pass and the JDBC pass edit the same statement without colliding', () => {
  const out = run(`
function handleGet() {
  var conn = $.db.getConnection();
  var pstmt = conn.prepareStatement('SELECT EMPID FROM "T"."E" WHERE EMPID = ?');
  pstmt.setNString(1, $.request.parameters.get("EMPID"));
  var rs = pstmt.executeQuery();
  var out = [];
  while (rs.next()) { out.push({ EMPID: rs.getNString(1) }); }
  return out;
}
function processRequest() { $.response.setBody(JSON.stringify(handleGet())); }
processRequest();
`);
  assert.match(out.text, /await cds\.run\(/);
  assert.match(out.text, /cds\.context\.data\.EMPID/);   // a helper, so not `req`
  assert.match(out.text, /return JSON\.stringify\(await handleGet\(\)\);/);
  assert.ok(parses(out.text));
});
