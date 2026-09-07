import assert from 'node:assert/strict';
import { transformFile } from '../src/transform/file.js';
import { parse, parentMap } from '../src/transform/js.js';
import { analyseHttp } from '../src/transform/http.js';

const REL = 'Env_Config/Thing.xsjslib';
const run = (src) => transformFile(src, { schema: 'TECK', relPath: REL, filename: REL });
const parses = (text) => { parse(text, { sourceType: 'module' }); return true; };
const codes = (out) => out.findings.map((f) => f.code);
const chains = (src) => { const ast = parse(src, { filename: REL }); return analyseHttp(ast, parentMap(ast)); };

const CALL = `
function getToken() {
  var dest, client, req, response;
  dest = $.net.http.readDestination("TECK.Env_Config", "CmisAccessToken");
  client = new $.net.http.Client();
  req = new $.web.WebRequest($.net.http.POST, "/oauth2/api/v1/token");
  req.headers.set("Content-Type", "application/json");
  client.request(req, dest);
  response = client.getResponse();
  client.close();
  return JSON.parse(response.body.asString());
}
`;

/* ---------------- the whole chain becomes one call ---------------- */

test('the six-statement destination chain collapses to one executeHttpRequest', () => {
  const out = run(CALL);
  assert.match(out.text, /^import \{ executeHttpRequest \} from "@sap-cloud-sdk\/http-client";/m);
  assert.match(out.text, /response = await executeHttpRequest\(/);
  assert.match(out.text, /\{ destinationName: "CmisAccessToken" \}/);
  assert.match(out.text, /method: "POST"/);
  assert.match(out.text, /url: "\/oauth2\/api\/v1\/token"/);
  assert.match(out.text, /"Content-Type": "application\/json"/);
  // Everything the call replaced is gone.
  assert.doesNotMatch(out.text, /readDestination|new \$\.net\.http\.Client|WebRequest|client\.request|getResponse|client\.close/);
  assert.ok(parses(out.text));
});

test('the package half of readDestination is dropped — CF destination names are flat', () => {
  const [c] = chains(CALL);
  assert.equal(c.destName, 'CmisAccessToken');
  assert.equal(c.resolved, true);
});

test('the enclosing function becomes async', () => {
  const out = run(CALL);
  assert.match(out.text, /async function getToken/);
});

test('JSON.parse(response.body.asString()) is just the parsed body', () => {
  const out = run(CALL);
  assert.match(out.text, /return response\.data;/);
});

test('a bare response.body.asString() keeps its string type', () => {
  const out = run(CALL.replace('return JSON.parse(response.body.asString());', 'return response.body.asString();'));
  assert.match(out.text, /return JSON\.stringify\(response\.data\);/);
});

test('response.status needs no rewrite — the SDK response has one too', () => {
  const out = run(CALL.replace('return JSON.parse(response.body.asString());', 'return response.status === 201;'));
  assert.match(out.text, /return response\.status === 201;/);
});

/* ---------------- the pieces ---------------- */

test('parameters and a body land in params and data', () => {
  const out = run(`
function push(names) {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.PUT, "/groups/users");
  req.parameters.set("groupName", GROUPNAME);
  req.setBody('{"users":' + JSON.stringify(names) + '}');
  client.request(req, dest);
  client.getResponse();
}
`);
  assert.match(out.text, /params: \{\s*"groupName": GROUPNAME,/);
  assert.match(out.text, /data: '\{"users":' \+ JSON\.stringify\(names\) \+ '\}'/);
  assert.ok(parses(out.text));
});

test('req.contentType is a property, and means the same as the header', () => {
  const out = run(CALL.replace('req.headers.set("Content-Type", "application/json");', "req.contentType = 'application/json';"));
  assert.match(out.text, /"Content-Type": 'application\/json'/);
  assert.doesNotMatch(out.text, /contentType/);
});

test('a discarded response is fire-and-forget, not a refusal', () => {
  const out = run(`
function ping() {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.GET, "/ping");
  client.request(req, dest);
  client.getResponse();
}
`);
  assert.match(out.text, /await executeHttpRequest\(/);
  assert.equal(codes(out).length, 0);
  assert.ok(parses(out.text));
});

test('a destination read once at module level is found from inside every function', () => {
  const out = run(`
var userDest = $.net.http.readDestination("TECK.Env_Config", "User_RoleAccess");
var userClient = new $.net.http.Client();
function addUsers() {
  var req = new $.web.WebRequest($.net.http.PUT, "/groups/users");
  userClient.request(req, userDest);
  userClient.getResponse();
}
`);
  assert.match(out.text, /destinationName: "User_RoleAccess"/);
  assert.ok(parses(out.text));
});

test('two calls down one reused req variable both convert', () => {
  const [a, b] = chains(`
function two() {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.PUT, "/one");
  client.request(req, dest);
  var r1 = client.getResponse();
  req = new $.web.WebRequest($.net.http.DEL, "/two");
  client.request(req, dest);
  var r2 = client.getResponse();
}
`);
  assert.equal(a.resolved, true);
  assert.equal(b.resolved, true);
  assert.equal(a.method, 'PUT');
  assert.equal(b.method, 'DELETE');   // XSJS spells it DEL
});

/* ---------------- what it refuses ---------------- */

test('a request built by an if/else and sent once is refused, not guessed at', () => {
  // Picking any branch would hard-code that URL for all of them.
  const src = `
function create(mName) {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req;
  if (mName === 'A') { req = new $.web.WebRequest($.net.http.POST, "/a"); }
  else { req = new $.web.WebRequest($.net.http.POST, "/b"); }
  client.request(req, dest);
  var r = client.getResponse();
}
`;
  assert.deepEqual(chains(src).map((c) => c.resolved), [false, false]);
  const out = run(src);
  assert.ok(codes(out).includes('HTTP_REQUEST_CONDITIONAL'));
  assert.match(out.text, /NEEDS HUMAN REVIEW/);
  assert.match(out.text, /new \$\.web\.WebRequest/);   // left exactly as found
});

test('a destination whose name is computed is refused', () => {
  const [c] = chains(`
function go(which) {
  var dest = $.net.http.readDestination("P", which);
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.GET, "/x");
  client.request(req, dest);
  client.getResponse();
}
`);
  assert.equal(c.resolved, false);
  assert.deepEqual(c.gaps.map((g) => g.code), ['DESTINATION_DYNAMIC']);
});

test('a request that is never sent is reported as dead code', () => {
  const [c] = chains(`
function go() {
  var req = new $.web.WebRequest($.net.http.GET, "/x");
  req.headers.set("A", "B");
}
`);
  assert.deepEqual(c.gaps.map((g) => g.code), ['HTTP_NOT_SENT']);
});

test('two functions sharing the names dest/client/req do not steal each other\'s calls', () => {
  // XSJS leaks undeclared variables to the global object, so this is routine.
  const cs = chains(`
function one() {
  dest = $.net.http.readDestination("P", "D1");
  client = new $.net.http.Client();
  req = new $.web.WebRequest($.net.http.POST, "/one");
  client.request(req, dest);
  response = client.getResponse();
}
function two() {
  dest = $.net.http.readDestination("P", "D2");
  client = new $.net.http.Client();
  req = new $.web.WebRequest($.net.http.POST, "/two");
  client.request(req, dest);
  response = client.getResponse();
}
`);
  assert.deepEqual(cs.map((c) => c.resolved), [true, true]);
  assert.deepEqual(cs.map((c) => c.destName), ['D1', 'D2']);
});

test('a destination statement shared by two calls is removed once, not left behind', () => {
  // Two identical deletion edits used to look "inside" each other to the
  // composer's inside-a-removed-range filter, which dropped both.
  const out = run(`
function two() {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.PUT, "/one");
  client.request(req, dest);
  var r1 = client.getResponse();
  req = new $.web.WebRequest($.net.http.DEL, "/two");
  client.request(req, dest);
  var r2 = client.getResponse();
}
`);
  assert.doesNotMatch(out.text, /readDestination/);
  assert.doesNotMatch(out.text, /new \$\.net\.http\.Client/);
  assert.equal(out.text.match(/executeHttpRequest\(/g).length, 2);
  assert.ok(parses(out.text));
});

test('a header set twice is emitted once, with the value that wins', () => {
  const out = run(`
function go() {
  var dest = $.net.http.readDestination("P", "D");
  var client = new $.net.http.Client();
  var req = new $.web.WebRequest($.net.http.POST, "/x");
  req.headers.set("Content-Type", "text/plain");
  req.contentType = "application/json";
  client.request(req, dest);
  client.getResponse();
}
`);
  assert.equal(out.text.match(/"Content-Type":/g).length, 1);
  assert.match(out.text, /"Content-Type": "application\/json"/);
});
